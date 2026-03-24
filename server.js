/**
 * VAPI WEBHOOK SERVER — Adapter for existing Supermenu POS Bridge
 * 
 * Vapi sends tool calls to your serverUrl. This server receives them
 * and forwards to your existing supermenu-pos-bridge endpoints.
 * 
 * Deploy this alongside your existing bridge, or add these routes to it.
 * 
 * npm install express axios
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const POS_BRIDGE_BASE = 'https://supermenu-pos-bridge.onrender.com';

// ============================================================
// VAPI SERVER MESSAGE WEBHOOK
// Vapi sends ALL events to this single endpoint
// ============================================================
app.post('/vapi/webhook', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(200).json({});
  }

  switch (message.type) {
    // ---- Tool calls from the assistant ----
    case 'tool-calls': {
      const results = [];

      for (const toolCall of message.toolCallList) {
        const { id, function: fn } = toolCall;
        const { name, arguments: args } = fn;

        let result;
        try {
          result = await handleToolCall(name, args, req.body);
        } catch (err) {
          console.error(`Tool ${name} failed:`, err.message);
          result = { error: true, message: `Tool failed: ${err.message}` };
        }

        results.push({
          toolCallId: id,
          result: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }

      return res.status(200).json({ results });
    }

    // ---- Call started ----
    case 'status-update': {
      if (message.status === 'ended') {
        console.log('Call ended:', message.endedReason);
      }
      return res.status(200).json({});
    }

    // ---- Transcript updates (optional logging) ----
    case 'transcript': {
      // Optional: log transcripts for debugging
      return res.status(200).json({});
    }

    // ---- End of call report ----
    case 'end-of-call-report': {
      console.log('Call report:', {
        duration: message.durationSeconds,
        cost: message.cost,
        summary: message.summary
      });
      return res.status(200).json({});
    }

    default:
      return res.status(200).json({});
  }
});

// ============================================================
// TOOL CALL ROUTER
// Maps Vapi tool calls to your existing POS bridge endpoints
// ============================================================
async function handleToolCall(name, args, fullPayload) {
  switch (name) {
    case 'verify_address': {
      const response = await axios.post(
        `${POS_BRIDGE_BASE}/retell/function/verify_address`,
        { args: { address: args.address } },
        { timeout: 25000 }
      );
      return response.data;
    }

    case 'process_payment': {
      const response = await axios.post(
        `${POS_BRIDGE_BASE}/retell/function/process_payment`,
        {
          args: {
            card_number: args.card_number,
            expiration: args.expiration,
            cvv: args.cvv,
            amount: args.amount,
            zip: args.zip || '',
            invoice: args.invoice || ''
          }
        },
        { timeout: 25000 }
      );
      return response.data;
    }

    case 'get_caller_id': {
      // Extract caller's phone from Vapi call metadata
      const callerPhone = fullPayload?.call?.customer?.number || '';
      
      if (callerPhone) {
        // Format: +14105551234 → (410) 555-1234
        const digits = callerPhone.replace(/\D/g, '').slice(-10);
        const formatted = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
        return { status: 'found', phone: formatted, raw: digits };
      }

      // Fallback to POS bridge
      try {
        const response = await axios.post(
          `${POS_BRIDGE_BASE}/retell/function/get_caller_id`,
          { args: {} },
          { timeout: 10000 }
        );
        return response.data;
      } catch {
        return { status: 'NO_PHONE' };
      }
    }

    case 'submit_order': {
      const response = await axios.post(
        `${POS_BRIDGE_BASE}/retell/function/submit_order`,
        { args: args },
        { timeout: 25000 }
      );
      return response.data;
    }

    default:
      return { error: true, message: `Unknown tool: ${name}` };
  }
}

// ============================================================
// DIRECT VAPI TOOL ENDPOINTS (alternative to serverUrl approach)
// If you configure tools with direct URLs instead of serverUrl
// ============================================================
app.post('/vapi/function/verify_address', async (req, res) => {
  try {
    const { message } = req.body;
    const args = message?.toolCallList?.[0]?.function?.arguments || req.body;
    
    const response = await axios.post(
      `${POS_BRIDGE_BASE}/retell/function/verify_address`,
      { args: { address: args.address } },
      { timeout: 25000 }
    );

    res.json({
      results: [{
        toolCallId: message?.toolCallList?.[0]?.id || 'unknown',
        result: JSON.stringify(response.data)
      }]
    });
  } catch (err) {
    res.json({
      results: [{
        toolCallId: 'unknown',
        result: JSON.stringify({ error: true, message: err.message })
      }]
    });
  }
});

app.post('/vapi/function/process_payment', async (req, res) => {
  try {
    const { message } = req.body;
    const args = message?.toolCallList?.[0]?.function?.arguments || req.body;
    
    const response = await axios.post(
      `${POS_BRIDGE_BASE}/retell/function/process_payment`,
      { args },
      { timeout: 25000 }
    );

    res.json({
      results: [{
        toolCallId: message?.toolCallList?.[0]?.id || 'unknown',
        result: JSON.stringify(response.data)
      }]
    });
  } catch (err) {
    res.json({
      results: [{
        toolCallId: 'unknown',
        result: JSON.stringify({ error: true, message: err.message })
      }]
    });
  }
});

app.post('/vapi/function/get_caller_id', async (req, res) => {
  try {
    const callerPhone = req.body?.call?.customer?.number || '';
    let result;
    
    if (callerPhone) {
      const digits = callerPhone.replace(/\D/g, '').slice(-10);
      result = { status: 'found', phone: `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}` };
    } else {
      result = { status: 'NO_PHONE' };
    }

    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'unknown',
        result: JSON.stringify(result)
      }]
    });
  } catch (err) {
    res.json({
      results: [{
        toolCallId: 'unknown',
        result: JSON.stringify({ status: 'NO_PHONE' })
      }]
    });
  }
});

app.post('/vapi/function/submit_order', async (req, res) => {
  try {
    const { message } = req.body;
    const args = message?.toolCallList?.[0]?.function?.arguments || req.body;
    
    const response = await axios.post(
      `${POS_BRIDGE_BASE}/retell/function/submit_order`,
      { args },
      { timeout: 25000 }
    );

    res.json({
      results: [{
        toolCallId: message?.toolCallList?.[0]?.id || 'unknown',
        result: JSON.stringify(response.data)
      }]
    });
  } catch (err) {
    res.json({
      results: [{
        toolCallId: 'unknown',
        result: JSON.stringify({ error: true, message: err.message })
      }]
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', platform: 'vapi-adapter' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Vapi webhook adapter running on port ${PORT}`);
});

// ============================================================
// PASTE THIS INTO YOUR EXISTING server.js (before app.listen)
// Routes Vapi function-call messages to your existing handlers
// ============================================================

app.post('/vapi/webhook', async (req, res) => {
  const { message } = req.body;

  if (!message || message.type !== 'function-call') {
    return res.status(200).json({});
  }

  const name = message.functionCall?.name;
  const args = message.functionCall?.parameters || {};

  console.log(`[VAPI] ${name}`, JSON.stringify(args).slice(0, 200));

  let result;
  try {
    switch (name) {
      case 'verify_address':
        // Call your existing verify_address handler
        result = await handleVerifyAddress({ address: args.address });
        break;

      case 'process_payment':
        // Call your existing process_payment handler
        result = await handleProcessPayment({
          card_number: args.card_number,
          expiration: args.expiration,
          cvv: args.cvv,
          amount: args.amount,
          zip: args.zip || '',
          invoice: args.invoice || ''
        });
        break;

      case 'get_caller_id': {
        const phone = req.body?.call?.customer?.number || '';
        if (phone) {
          const d = phone.replace(/\D/g, '').slice(-10);
          result = { status: 'found', phone: `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` };
        } else {
          result = await handleGetCallerId();
        }
        break;
      }

      case 'submit_order':
        // Call your existing submit_order handler
        result = await handleSubmitOrder(args);
        break;

      default:
        result = { error: true, message: `Unknown: ${name}` };
    }
  } catch (err) {
    console.error(`[VAPI] ${name} error:`, err.message);
    result = { error: true, message: err.message };
  }

  // Vapi expects { result: "string" } for function-call responses
  return res.status(200).json({
    result: typeof result === 'string' ? result : JSON.stringify(result)
  });
});

// ============================================================
// IMPORTANT: Replace these function names with YOUR actual handlers
// from your existing server.js code:
//
//   handleVerifyAddress  → your verify_address handler
//   handleProcessPayment → your process_payment handler  
//   handleGetCallerId    → your get_caller_id handler
//   handleSubmitOrder    → your submit_order handler
//
// If your existing handlers are inline in route callbacks,
// extract them into named functions first.
// ============================================================

/**
 * server.js — Retell AI Tool Server
 * 
 * Handles all tool calls from the Retell voice agent.
 * Routes to appropriate service based on tool name.
 * 
 * Deploy this as an Express server accessible via webhook URL
 * configured in Retell's agent settings.
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ComboEngine = require('./services/comboEngine');
const PosMapper = require('./services/posMapper');

const app = express();
app.use(express.json());

// ─── Tenant Config Loader ───────────────────────────────────────────────────

const tenantCache = {};

function loadTenant(tenantId) {
  if (tenantCache[tenantId]) return tenantCache[tenantId];

  const basePath = path.join(__dirname, 'config', 'tenants', tenantId);

  try {
    const tenantConfig = JSON.parse(fs.readFileSync(path.join(basePath, 'tenant_config.json'), 'utf-8'));
    const menuItems = JSON.parse(fs.readFileSync(path.join(basePath, 'menu_items.json'), 'utf-8'));
    const modifiers = JSON.parse(fs.readFileSync(path.join(basePath, 'modifiers.json'), 'utf-8'));
    const combos = JSON.parse(fs.readFileSync(path.join(basePath, 'combos.json'), 'utf-8'));
    const synonyms = JSON.parse(fs.readFileSync(path.join(basePath, 'synonyms.json'), 'utf-8'));

    // ─── OVERRIDE SECRETS FROM ENVIRONMENT VARIABLES ───
    // These override whatever is in tenant_config.json so you
    // never have to put real passwords in your GitHub repo.
    //
    // For multi-tenant: use TENANT_ID prefix, e.g.:
    //   PIZZA_DEMO_RESTON_POS_ID, PIZZA_DEMO_RESTON_POS_PASSWORD
    // Falls back to generic env vars, then to config file values.
    
    const envPrefix = tenantId.toUpperCase().replace(/-/g, '_');

    // POS credentials
    tenantConfig.pos.restaurant_id =
      process.env[`${envPrefix}_POS_ID`] ||
      process.env.POS_RESTAURANT_ID ||
      tenantConfig.pos.restaurant_id;

    tenantConfig.pos.password =
      process.env[`${envPrefix}_POS_PASSWORD`] ||
      process.env.POS_PASSWORD ||
      tenantConfig.pos.password;

    // Google Maps API key
    tenantConfig.google_maps_api_key =
      process.env[`${envPrefix}_GOOGLE_MAPS_KEY`] ||
      process.env.GOOGLE_MAPS_API_KEY ||
      tenantConfig.google_maps_api_key;

    // Supermenu endpoint (in case you need to switch test vs production)
    tenantConfig.pos.endpoint =
      process.env[`${envPrefix}_POS_ENDPOINT`] ||
      process.env.POS_ENDPOINT ||
      tenantConfig.pos.endpoint;

    console.log(`Loaded tenant: ${tenantId}`);
    console.log(`  POS ID: ${tenantConfig.pos.restaurant_id}`);
    console.log(`  POS endpoint: ${tenantConfig.pos.endpoint}`);
    console.log(`  Google Maps key: ${tenantConfig.google_maps_api_key ? '✓ set' : '✗ MISSING'}`);

    const tenant = {
      config: tenantConfig,
      menuItems,
      modifiers,
      combos,
      synonyms,
      comboEngine: new ComboEngine(menuItems, modifiers, combos, tenantConfig),
      posMapper: new PosMapper(tenantConfig)
    };

    tenantCache[tenantId] = tenant;
    return tenant;
  } catch (err) {
    console.error(`Failed to load tenant ${tenantId}:`, err.message);
    return null;
  }
}

// ─── Health Check (GET /) ────────────────────────────────────────────────────
// Lets you verify the server is running by visiting the URL in a browser.
// Also used by Render's health checks to know the service is alive.

app.get('/', (req, res) => {
  const envStatus = {
    POS_RESTAURANT_ID: process.env.POS_RESTAURANT_ID ? '✓ set' : '✗ NOT SET',
    POS_PASSWORD: process.env.POS_PASSWORD ? '✓ set' : '✗ NOT SET',
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY ? '✓ set' : '✗ NOT SET'
  };

  res.json({
    status: 'running',
    service: 'Retell AI Restaurant Order Server',
    environment_variables: envStatus,
    timestamp: new Date().toISOString()
  });
});

// ─── Retell Webhook Handler ─────────────────────────────────────────────────

app.post('/retell-webhook', async (req, res) => {
  try {
    const { tool_call_list } = req.body;

    if (!tool_call_list || tool_call_list.length === 0) {
      return res.json({ tool_results: [] });
    }

    const results = [];

    for (const toolCall of tool_call_list) {
      const { tool_call_id, name, arguments: args } = toolCall;
      let result;

      try {
        switch (name) {
          case 'verify_address':
            result = await handleVerifyAddress(args);
            break;
          case 'lookup_menu':
            result = await handleLookupMenu(args);
            break;
          case 'price_order':
            result = await handlePriceOrder(args);
            break;
          case 'submit_order':
            result = await handleSubmitOrder(args);
            break;
          case 'transfer_call':
            result = handleTransferCall(args);
            break;
          default:
            result = { error: `Unknown tool: ${name}` };
        }
      } catch (err) {
        console.error(`Tool ${name} error:`, err);
        result = { error: `Tool failed: ${err.message}` };
      }

      results.push({
        tool_call_id,
        result: JSON.stringify(result)
      });
    }

    res.json({ tool_results: results });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Tool Handlers ──────────────────────────────────────────────────────────

/**
 * VERIFY_ADDRESS: Geocode address and check delivery range.
 */
async function handleVerifyAddress(args) {
  const { raw_address, tenant_id } = args;
  const tenant = loadTenant(tenant_id);

  if (!tenant) {
    return { valid: false, error: 'Restaurant configuration not found' };
  }

  const config = tenant.config;

  try {
    // Call Google Maps Geocoding API
    const geocodeUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
    const response = await axios.get(geocodeUrl, {
      params: {
        address: raw_address,
        key: config.google_maps_api_key
      }
    });

    if (response.data.status !== 'OK' || response.data.results.length === 0) {
      return {
        valid: false,
        in_range: false,
        error: 'Could not verify that address. Please provide the full street address.'
      };
    }

    const result = response.data.results[0];
    const location = result.geometry.location;

    // Parse address components
    const components = {};
    for (const comp of result.address_components) {
      if (comp.types.includes('street_number')) components.street_number = comp.long_name;
      if (comp.types.includes('route')) components.route = comp.long_name;
      if (comp.types.includes('locality')) components.city = comp.long_name;
      if (comp.types.includes('administrative_area_level_1')) components.state = comp.short_name;
      if (comp.types.includes('postal_code')) components.zip = comp.long_name;
    }

    const line1 = [components.street_number, components.route].filter(Boolean).join(' ');

    // Calculate distance from store
    const distance = haversineDistance(
      config.address.lat, config.address.lng,
      location.lat, location.lng
    );

    const inRange = distance <= config.delivery.max_distance_miles;

    return {
      valid: true,
      in_range: inRange,
      formatted_address: result.formatted_address,
      address_components: {
        line1: line1 || result.formatted_address.split(',')[0],
        city: components.city || '',
        state: components.state || '',
        zip: components.zip || ''
      },
      distance_miles: Math.round(distance * 10) / 10,
      max_distance_miles: config.delivery.max_distance_miles,
      error: inRange ? null : `Address is ${Math.round(distance * 10) / 10} miles away. Maximum delivery distance is ${config.delivery.max_distance_miles} miles.`
    };
  } catch (err) {
    console.error('Geocoding error:', err.message);
    return {
      valid: false,
      in_range: false,
      error: 'Address verification service is temporarily unavailable.'
    };
  }
}

/**
 * LOOKUP_MENU: Fuzzy match menu items by query.
 */
async function handleLookupMenu(args) {
  const { query, tenant_id } = args;
  const tenant = loadTenant(tenant_id);

  if (!tenant) {
    return { found: false, error: 'Restaurant configuration not found' };
  }

  const normalizedQuery = query.toLowerCase().trim();
  const results = [];

  // Check synonyms first
  for (const [synonym, itemKey] of Object.entries(tenant.synonyms.item_synonyms || {})) {
    if (normalizedQuery.includes(synonym.toLowerCase())) {
      // Handle special synonym formats like "soda_can:Coke"
      if (itemKey.includes(':')) {
        const [key, modifier] = itemKey.split(':');
        const item = tenant.menuItems.items.find(i => i.item_key === key);
        if (item) {
          results.push(formatMenuResult(item, tenant.modifiers));
        }
      } else if (itemKey.startsWith('ask:')) {
        // Multiple options — return them all
        const keys = itemKey.replace('ask:', '').split(',');
        for (const key of keys) {
          const item = tenant.menuItems.items.find(i => i.item_key === key.trim());
          if (item) results.push(formatMenuResult(item, tenant.modifiers));
        }
      } else {
        // Direct item key or partial key
        const matchingItems = tenant.menuItems.items.filter(
          i => i.item_key === itemKey || i.item_key.startsWith(itemKey)
        );
        for (const item of matchingItems) {
          results.push(formatMenuResult(item, tenant.modifiers));
        }
      }
    }
  }

  // Fuzzy match on item names and spoken names
  if (results.length === 0) {
    for (const item of tenant.menuItems.items) {
      if (!item.available) continue;

      const nameMatch = item.name.toLowerCase().includes(normalizedQuery) ||
        (item.spoken_name && item.spoken_name.toLowerCase().includes(normalizedQuery));
      const categoryMatch = item.category.toLowerCase() === normalizedQuery ||
        (item.subcategory && item.subcategory.toLowerCase().includes(normalizedQuery));

      if (nameMatch || categoryMatch) {
        results.push(formatMenuResult(item, tenant.modifiers));
      }
    }
  }

  // Partial word matching as fallback
  if (results.length === 0) {
    const queryWords = normalizedQuery.split(/\s+/);
    for (const item of tenant.menuItems.items) {
      if (!item.available) continue;

      const itemWords = `${item.name} ${item.spoken_name || ''} ${item.category}`.toLowerCase();
      const matchCount = queryWords.filter(w => itemWords.includes(w)).length;

      if (matchCount >= Math.ceil(queryWords.length * 0.5)) {
        results.push({
          ...formatMenuResult(item, tenant.modifiers),
          match_confidence: matchCount / queryWords.length
        });
      }
    }
    results.sort((a, b) => (b.match_confidence || 0) - (a.match_confidence || 0));
  }

  const found = results.length > 0;
  return {
    found,
    items: results.slice(0, 5), // Return top 5 matches
    suggestion: found ? null : `No items match "${query}". Try asking for pizza, wings, subs, or salads.`
  };
}

function formatMenuResult(item, modifiers) {
  const requiredMods = [];
  for (const groupKey of (item.required_modifier_groups || [])) {
    const group = modifiers.modifier_groups.find(g => g.group_key === groupKey);
    if (group && group.required) {
      requiredMods.push({
        group_key: group.group_key,
        display_name: group.display_name,
        prompt_question: group.prompt_question,
        options_summary: group.options.slice(0, 8).map(o => o.name).join(', ') +
          (group.options.length > 8 ? ', and more' : '')
      });
    }
  }

  return {
    item_key: item.item_key,
    name: item.name,
    size: item.size,
    base_price: item.base_price,
    required_modifiers: requiredMods
  };
}

/**
 * PRICE_ORDER: Run combo engine and return optimal pricing.
 */
async function handlePriceOrder(args) {
  const { tenant_id, order_type, items, combo_opt_outs } = args;
  const tenant = loadTenant(tenant_id);

  if (!tenant) {
    return { valid: false, error: 'Restaurant configuration not found' };
  }

  // Check store hours
  if (!isStoreOpen(tenant.config)) {
    return {
      valid: false,
      validation_errors: [{
        cart_item_id: null,
        item_name: null,
        missing_modifier_group: null,
        prompt_question: `We're currently closed. Our hours are ${formatHours(tenant.config)}.`
      }],
      applied_combos: [],
      standalone_items: [],
      subtotal: 0, tax: 0, delivery_fee: 0, total: 0,
      order_summary: ''
    };
  }

  // Run the combo engine
  const result = tenant.comboEngine.priceOrder(
    items || [],
    order_type,
    combo_opt_outs || []
  );

  // Check delivery minimum
  if (order_type === 'delivery' && result.valid && result.subtotal < tenant.config.delivery.minimum_order) {
    result.delivery_minimum_warning = `Delivery minimum is $${tenant.config.delivery.minimum_order.toFixed(2)}. Your current subtotal is $${result.subtotal.toFixed(2)}. Please add $${(tenant.config.delivery.minimum_order - result.subtotal).toFixed(2)} more.`;
  }

  return result;
}

/**
 * SUBMIT_ORDER: Final combo detection + POS XML build + POST to Supermenu.
 */
async function handleSubmitOrder(args) {
  const {
    tenant_id, order_type, customer, delivery_address,
    items, combo_opt_outs, payment, special_instructions
  } = args;

  const tenant = loadTenant(tenant_id);
  if (!tenant) {
    return { success: false, error: 'Restaurant configuration not found' };
  }

  // Step 1: Final price calculation (re-runs combo engine for safety)
  const pricedCart = tenant.comboEngine.priceOrder(
    items || [],
    order_type,
    combo_opt_outs || []
  );

  if (!pricedCart.valid) {
    return {
      success: false,
      error: `Order validation failed: ${pricedCart.validation_errors.map(e => e.prompt_question).join('; ')}`
    };
  }

  // Add special instructions and payment to priced cart
  pricedCart.special_instructions = special_instructions || '';
  pricedCart.payment = payment || tenant.config.default_payment || 'CASH';

  // Step 2: Build Supermenu XML
  const xml = tenant.posMapper.buildOrderXML(
    pricedCart,
    customer,
    order_type,
    delivery_address || null,
    pricedCart.payment,
    pricedCart.special_instructions
  );

  // Step 3: POST to Supermenu
  try {
    const postParams = tenant.posMapper.buildPostParams(xml);

    console.log('Submitting order to Supermenu:', {
      url: postParams.url,
      restaurantId: postParams.params.id,
      orderType: order_type,
      total: pricedCart.total
    });

    const response = await axios.post(postParams.url, xml, {
      params: postParams.params,
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000
    });

    // Parse response for success/failure
    const responseText = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    if (responseText.toLowerCase().includes('success')) {
      // Extract order ID if present
      const orderIdMatch = responseText.match(/order\s*(?:id|#|number)[:\s]*(\d+)/i);
      const orderId = orderIdMatch ? orderIdMatch[1] : refNumber.toString();

      const eta = order_type === 'delivery'
        ? `${tenant.config.delivery.eta_minutes.min}-${tenant.config.delivery.eta_minutes.max} minutes`
        : `${tenant.config.pickup.eta_minutes.min}-${tenant.config.pickup.eta_minutes.max} minutes`;

      return {
        success: true,
        order_id: orderId,
        reference_number: tenant.posMapper.generateReferenceNumber(),
        eta_minutes: eta,
        error: null
      };
    } else {
      console.error('Supermenu rejection:', responseText);
      return {
        success: false,
        error: 'The restaurant system could not process the order. Please try again or we can transfer you to the restaurant.'
      };
    }
  } catch (err) {
    console.error('Supermenu POST error:', err.message);
    return {
      success: false,
      error: 'Could not connect to the restaurant system. Please transfer to the restaurant.'
    };
  }
}

/**
 * TRANSFER_CALL: Return transfer signal to Retell.
 */
function handleTransferCall(args) {
  const tenant = loadTenant(args.tenant_id);
  const transferNumber = tenant
    ? tenant.config.transfer_number
    : '(888) 888-8888';

  return {
    action: 'transfer',
    transfer_number: transferNumber,
    reason: args.reason || 'Customer requested transfer'
  };
}

// ─── Utility Functions ──────────────────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

function isStoreOpen(config) {
  const now = new Date();
  const tz = config.hours?.timezone || 'America/New_York';
  const options = { timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  const day = parts.find(p => p.type === 'weekday')?.value?.toLowerCase();
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
  const currentMinutes = hour * 60 + minute;

  const schedule = config.hours?.schedule?.[day];
  if (!schedule) return false;

  const [openH, openM] = schedule.open.split(':').map(Number);
  const [closeH, closeM] = schedule.close.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

function formatHours(config) {
  const schedule = config.hours?.schedule;
  if (!schedule) return 'hours unavailable';
  const sample = Object.values(schedule)[0];
  if (!sample) return 'hours unavailable';
  return `${sample.open} to ${sample.close}`;
}

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Retell Tool Server running on port ${PORT}`);
});

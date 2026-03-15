/**
 * server.js — Retell AI Tool Server for Conversation Flow Agents
 * 
 * Each tool gets its own endpoint: /retell/function/{tool_name}
 * Retell POSTs { args: {...} } and expects { result: "..." } back.
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ComboEngine = require('./services/comboEngine');
const PosMapper = require('./services/posMapper');

const app = express();
app.use(express.json());

// ─── Session Cart Storage (in-memory, per call) ────────────────────────────
// In production, use Redis. For now, keyed by call_id.
const carts = {};

function getCart(callId) {
  if (!carts[callId]) {
    carts[callId] = { items: [], order_type: 'pickup', delivery_address: null };
  }
  return carts[callId];
}

// Clean up old carts every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, cart] of Object.entries(carts)) {
    if (cart._created && now - cart._created > 3600000) {
      delete carts[id];
    }
  }
}, 1800000);

// ─── Tenant Config Loader ───────────────────────────────────────────────────

const tenantCache = {};
const DEFAULT_TENANT = 'pizza_demo_reston';

function loadTenant(tenantId) {
  tenantId = tenantId || DEFAULT_TENANT;
  if (tenantCache[tenantId]) return tenantCache[tenantId];

  const basePath = path.join(__dirname, 'config', 'tenants', tenantId);

  try {
    const tenantConfig = JSON.parse(fs.readFileSync(path.join(basePath, 'tenant_config.json'), 'utf-8'));
    const menuItems = JSON.parse(fs.readFileSync(path.join(basePath, 'menu_items.json'), 'utf-8'));
    const modifiers = JSON.parse(fs.readFileSync(path.join(basePath, 'modifiers.json'), 'utf-8'));
    const combos = JSON.parse(fs.readFileSync(path.join(basePath, 'combos.json'), 'utf-8'));
    const synonyms = JSON.parse(fs.readFileSync(path.join(basePath, 'synonyms.json'), 'utf-8'));

    // Override secrets from environment variables
    const envPrefix = tenantId.toUpperCase().replace(/-/g, '_');

    tenantConfig.pos.restaurant_id =
      process.env[`${envPrefix}_POS_ID`] ||
      process.env.POS_RESTAURANT_ID ||
      tenantConfig.pos.restaurant_id;

    tenantConfig.pos.password =
      process.env[`${envPrefix}_POS_PASSWORD`] ||
      process.env.POS_PASSWORD ||
      tenantConfig.pos.password;

    tenantConfig.google_maps_api_key =
      process.env[`${envPrefix}_GOOGLE_MAPS_KEY`] ||
      process.env.GOOGLE_MAPS_API_KEY ||
      tenantConfig.google_maps_api_key;

    tenantConfig.pos.endpoint =
      process.env[`${envPrefix}_POS_ENDPOINT`] ||
      process.env.POS_ENDPOINT ||
      tenantConfig.pos.endpoint;

    console.log(`Loaded tenant: ${tenantId}`);
    console.log(`  POS ID: ${tenantConfig.pos.restaurant_id}`);
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

// ─── Helper: Extract args from Retell's POST body ──────────────────────────
// Retell sends { args: {...}, call_id: "..." } for conversation flow tools

function getArgs(req) {
  // Retell conversation flow sends args at top level or under .args
  const body = req.body || {};
  const args = body.args || body;
  const callId = body.call_id || body.call?.call_id || 'default';
  return { args, callId };
}

function sendResult(res, result) {
  // Retell expects { result: "string" } back
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
  res.json({ result: resultStr });
}

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'Retell AI Restaurant Order Server',
    environment_variables: {
      POS_RESTAURANT_ID: process.env.POS_RESTAURANT_ID ? '✓ set' : '✗ NOT SET',
      POS_PASSWORD: process.env.POS_PASSWORD ? '✓ set' : '✗ NOT SET',
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY ? '✓ set' : '✗ NOT SET'
    },
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL ENDPOINTS — one per tool, matching the agent's URL pattern
// ═══════════════════════════════════════════════════════════════════════════

// ─── 1. SEARCH MENU ─────────────────────────────────────────────────────────

app.post('/retell/function/search_menu', (req, res) => {
  try {
    const { args } = getArgs(req);
    const query = (args.query || '').toLowerCase().trim();
    const tenant = loadTenant(DEFAULT_TENANT);
    if (!tenant) return sendResult(res, 'Menu not available right now.');

    const results = [];

    // Check synonyms
    for (const [synonym, itemKey] of Object.entries(tenant.synonyms.item_synonyms || {})) {
      if (query.includes(synonym.toLowerCase())) {
        const matches = tenant.menuItems.items.filter(
          i => i.available && (i.item_key === itemKey || i.item_key.startsWith(itemKey))
        );
        for (const item of matches) {
          results.push({ item_id: item.pos_item_id.toString(), item_key: item.item_key, name: item.name, size: item.size, price: item.base_price, category: item.category });
        }
      }
    }

    // Fuzzy match on names
    if (results.length === 0) {
      for (const item of tenant.menuItems.items) {
        if (!item.available) continue;
        const searchable = `${item.name} ${item.spoken_name || ''} ${item.category} ${item.subcategory || ''}`.toLowerCase();
        if (searchable.includes(query) || query.split(' ').every(w => searchable.includes(w))) {
          results.push({ item_id: item.pos_item_id.toString(), item_key: item.item_key, name: item.name, size: item.size, price: item.base_price, category: item.category });
        }
      }
    }

    if (results.length === 0) {
      return sendResult(res, `No items found matching "${args.query}". Try pizza, wings, subs, salads, pasta, or seafood.`);
    }

    // Deduplicate and limit
    const seen = new Set();
    const unique = results.filter(r => {
      if (seen.has(r.item_key)) return false;
      seen.add(r.item_key);
      return true;
    }).slice(0, 8);

    return sendResult(res, JSON.stringify({ found: true, items: unique }));
  } catch (err) {
    console.error('search_menu error:', err);
    sendResult(res, 'Search failed. Try again.');
  }
});

// ─── 2. GET ITEM DETAILS ────────────────────────────────────────────────────

app.post('/retell/function/get_item_details', (req, res) => {
  try {
    const { args } = getArgs(req);
    const itemId = args.item_id;
    const tenant = loadTenant(DEFAULT_TENANT);
    if (!tenant) return sendResult(res, 'Menu not available.');

    const item = tenant.menuItems.items.find(i => i.pos_item_id.toString() === itemId || i.item_key === itemId);
    if (!item) return sendResult(res, `Item ${itemId} not found.`);

    const requiredMods = [];
    for (const groupKey of (item.required_modifier_groups || [])) {
      const group = tenant.modifiers.modifier_groups.find(g => g.group_key === groupKey);
      if (group && group.required) {
        requiredMods.push({
          group_key: group.group_key,
          name: group.display_name,
          question: group.prompt_question,
          options: group.options.slice(0, 10).map(o => o.name).join(', ')
        });
      }
    }

    return sendResult(res, JSON.stringify({
      item_id: item.pos_item_id.toString(),
      item_key: item.item_key,
      name: item.name,
      size: item.size,
      price: item.base_price,
      category: item.category,
      required_modifiers: requiredMods
    }));
  } catch (err) {
    console.error('get_item_details error:', err);
    sendResult(res, 'Could not get item details.');
  }
});

// ─── 3. GET REQUIRED MODIFIERS ──────────────────────────────────────────────

app.post('/retell/function/get_required_modifiers', (req, res) => {
  try {
    const { args } = getArgs(req);
    const itemId = args.item_id;
    const tenant = loadTenant(DEFAULT_TENANT);
    if (!tenant) return sendResult(res, 'Menu not available.');

    const item = tenant.menuItems.items.find(i => i.pos_item_id.toString() === itemId || i.item_key === itemId);
    if (!item) return sendResult(res, `Item ${itemId} not found.`);

    const groups = [];
    for (const groupKey of (item.required_modifier_groups || [])) {
      const group = tenant.modifiers.modifier_groups.find(g => g.group_key === groupKey);
      if (group) {
        groups.push({
          group_id: group.group_key,
          name: group.display_name,
          required: group.required,
          question: group.prompt_question,
          options: group.options.map(o => ({ id: o.name, name: o.name, price: o.price || 0 }))
        });
      }
    }

    return sendResult(res, JSON.stringify({ item: item.name, modifier_groups: groups }));
  } catch (err) {
    console.error('get_required_modifiers error:', err);
    sendResult(res, 'Could not get modifiers.');
  }
});

// ─── 4. ADD TO CART ─────────────────────────────────────────────────────────

app.post('/retell/function/add_to_cart', (req, res) => {
  try {
    const { args, callId } = getArgs(req);
    const cart = getCart(callId);
    cart._created = cart._created || Date.now();

    const tenant = loadTenant(DEFAULT_TENANT);
    const item = tenant ? tenant.menuItems.items.find(
      i => i.pos_item_id.toString() === args.item_id || i.item_key === args.item_id
    ) : null;

    const cartItem = {
      item_id: args.item_id,
      name: item ? item.name : `Item ${args.item_id}`,
      size: args.size || (item ? item.size : ''),
      price: item ? item.base_price : 0,
      quantity: args.quantity || 1,
      modifiers: args.modifiers || [],
      special_instructions: args.special_instructions || '',
      category: item ? item.category : 'other'
    };

    cart.items.push(cartItem);
    const total = cart.items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0);

    return sendResult(res, `Added ${cartItem.quantity}x ${cartItem.name}${cartItem.size ? ' (' + cartItem.size + ')' : ''} to the order. Cart has ${cart.items.length} item(s), running subtotal about $${total.toFixed(2)}.`);
  } catch (err) {
    console.error('add_to_cart error:', err);
    sendResult(res, 'Item added.');
  }
});

// ─── 5. GET CART ────────────────────────────────────────────────────────────

app.post('/retell/function/get_cart', (req, res) => {
  try {
    const { args, callId } = getArgs(req);
    const cart = getCart(callId);
    if (args.order_type) cart.order_type = args.order_type;

    const tenant = loadTenant(DEFAULT_TENANT);
    const taxRate = tenant ? tenant.config.tax_rate : 0.06;
    const deliveryFee = (cart.order_type === 'delivery' && tenant) ? tenant.config.delivery.fee : 0;

    const subtotal = cart.items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0);
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax + deliveryFee) * 100) / 100;

    const itemList = cart.items.map((item, idx) =>
      `${idx}: ${item.quantity || 1}x ${item.name}${item.size ? ' (' + item.size + ')' : ''} — $${item.price.toFixed(2)}${item.special_instructions ? ' [' + item.special_instructions + ']' : ''}`
    ).join('\n');

    return sendResult(res, JSON.stringify({
      items: cart.items.map((item, idx) => ({ index: idx, ...item })),
      item_count: cart.items.length,
      order_type: cart.order_type,
      subtotal: subtotal.toFixed(2),
      tax: tax.toFixed(2),
      delivery_fee: deliveryFee.toFixed(2),
      total: total.toFixed(2),
      summary: itemList || 'Cart is empty.'
    }));
  } catch (err) {
    console.error('get_cart error:', err);
    sendResult(res, 'Cart is empty.');
  }
});

// ─── 6. REMOVE FROM CART ────────────────────────────────────────────────────

app.post('/retell/function/remove_from_cart', (req, res) => {
  try {
    const { args, callId } = getArgs(req);
    const cart = getCart(callId);
    const idx = args.cart_item_index;

    if (idx >= 0 && idx < cart.items.length) {
      const removed = cart.items.splice(idx, 1)[0];
      return sendResult(res, `Removed ${removed.name} from the order. ${cart.items.length} item(s) remaining.`);
    }
    return sendResult(res, 'Item not found in cart.');
  } catch (err) {
    console.error('remove_from_cart error:', err);
    sendResult(res, 'Could not remove item.');
  }
});

// ─── 7. CHECK COMBO DEALS ──────────────────────────────────────────────────

app.post('/retell/function/check_combo_deals', (req, res) => {
  try {
    const { args } = getArgs(req);
    const cartItems = args.cart_items || [];
    const orderType = args.order_type || 'pickup';
    const tenant = loadTenant(DEFAULT_TENANT);
    if (!tenant) return sendResult(res, JSON.stringify({ combos: [], near_misses: [] }));

    // Simple combo matching against the combos.json definitions
    const eligibleCombos = tenant.combos.combos
      .filter(c => c.order_types.includes(orderType));

    const matches = [];
    const nearMisses = [];

    for (const combo of eligibleCombos) {
      const nonAutoComponents = combo.components.filter(c => !c.auto_add);
      let matchCount = 0;
      let missingComponent = null;

      for (const component of nonAutoComponents) {
        const found = cartItems.some(ci => {
          const categoryMatch = component.match_tags.some(tag => {
            if (tag.startsWith('pizza_')) return ci.category === 'pizza' && ci.size === tag.replace('pizza_', '') + '"';
            if (tag.startsWith('buffalo_wings_')) return ci.category === 'buffalo_wings' && ci.piece_count === parseInt(tag.replace('buffalo_wings_', ''));
            if (tag.startsWith('whole_wings_')) return ci.category === 'whole_wings' && ci.piece_count === parseInt(tag.replace('whole_wings_', ''));
            if (tag === 'sub_8') return ci.category === 'sub' && (ci.size === '8' || ci.size === '8"' || ci.size === 'half');
            if (tag === 'soda_can') return ci.category === 'soda' && (ci.size === 'can' || !ci.size);
            if (tag === 'soda_2liter') return ci.category === 'soda' && (ci.size === '2liter' || ci.size === '2L');
            if (tag === 'fries') return ci.category === 'fries';
            if (tag === 'cheeseburger') return ci.category === 'sandwich';
            return false;
          });
          return categoryMatch;
        });

        if (found) {
          matchCount++;
        } else {
          missingComponent = component;
        }
      }

      const individualTotal = cartItems.reduce((sum, ci) => sum + (ci.price || 0), 0);

      if (matchCount === nonAutoComponents.length) {
        matches.push({
          combo_key: combo.combo_key,
          combo_name: combo.name,
          combo_price: combo.price,
          savings: Math.round((individualTotal - combo.price) * 100) / 100,
          components: nonAutoComponents.map(c => c.description || c.role)
        });
      } else if (matchCount === nonAutoComponents.length - 1 && missingComponent) {
        nearMisses.push({
          combo_name: combo.name,
          combo_price: combo.price,
          missing: missingComponent.description || missingComponent.role,
          potential_savings: Math.round((individualTotal - combo.price) * 100) / 100
        });
      }
    }

    return sendResult(res, JSON.stringify({
      combos_matched: matches,
      near_misses: nearMisses.slice(0, 2)
    }));
  } catch (err) {
    console.error('check_combo_deals error:', err);
    sendResult(res, JSON.stringify({ combos_matched: [], near_misses: [] }));
  }
});

// ─── 8. CALCULATE TOTAL ─────────────────────────────────────────────────────

app.post('/retell/function/calculate_total', (req, res) => {
  try {
    const { args, callId } = getArgs(req);
    const cart = getCart(callId);
    const orderType = args.order_type || cart.order_type || 'pickup';
    const tenant = loadTenant(DEFAULT_TENANT);
    const taxRate = tenant ? tenant.config.tax_rate : 0.06;
    const deliveryFee = (orderType === 'delivery' && tenant) ? tenant.config.delivery.fee : 0;

    const subtotal = cart.items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0);
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax + deliveryFee) * 100) / 100;

    const belowMinimum = orderType === 'delivery' && tenant && subtotal < tenant.config.delivery.minimum_order;

    return sendResult(res, JSON.stringify({
      subtotal: subtotal.toFixed(2),
      tax: tax.toFixed(2),
      delivery_fee: deliveryFee.toFixed(2),
      total: total.toFixed(2),
      item_count: cart.items.length,
      order_type: orderType,
      below_delivery_minimum: belowMinimum,
      delivery_minimum: tenant ? tenant.config.delivery.minimum_order : 10
    }));
  } catch (err) {
    console.error('calculate_total error:', err);
    sendResult(res, 'Could not calculate total.');
  }
});

// ─── 9. SUGGEST UPSELL (analytics only) ─────────────────────────────────────

app.post('/retell/function/suggest_upsell', (req, res) => {
  try {
    const { args } = getArgs(req);
    console.log('Upsell logged:', args);
    return sendResult(res, 'Upsell logged.');
  } catch (err) {
    sendResult(res, 'OK');
  }
});

// ─── 10. CHECK STORE HOURS ──────────────────────────────────────────────────

app.post('/retell/function/check_store_hours', (req, res) => {
  try {
    const tenant = loadTenant(DEFAULT_TENANT);
    if (!tenant) return sendResult(res, 'Store hours not available.');

    const config = tenant.config;
    const now = new Date();
    const tz = config.hours?.timezone || 'America/New_York';
    const options = { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    const currentMinutes = hour * 60 + minute;

    // 11:00 AM = 660, 10:00 PM = 1320
    const isOpen = currentMinutes >= 660 && currentMinutes < 1320;

    return sendResult(res, JSON.stringify({
      is_open: isOpen,
      hours: '11:00 AM to 10:00 PM daily',
      current_time: `${hour}:${minute.toString().padStart(2, '0')}`
    }));
  } catch (err) {
    sendResult(res, JSON.stringify({ is_open: true, hours: '11AM-10PM daily' }));
  }
});

// ─── 11. VERIFY ADDRESS ─────────────────────────────────────────────────────

app.post('/retell/function/verify_address', (req, res) => {
  handleVerifyAddress(req, res);
});

// Also handle the /retell-webhook route for backward compat
app.post('/retell-webhook', (req, res) => {
  handleVerifyAddress(req, res);
});

async function handleVerifyAddress(req, res) {
  try {
    const { args } = getArgs(req);
    const rawAddress = args.raw_address;
    const tenant = loadTenant(args.tenant_id || DEFAULT_TENANT);
    if (!tenant) return sendResult(res, JSON.stringify({ valid: false, error: 'Config not found.' }));

    const config = tenant.config;
    const apiKey = config.google_maps_api_key;

    if (!apiKey || apiKey === 'SET_IN_RENDER_ENV_VARS') {
      // No API key — do basic validation
      return sendResult(res, JSON.stringify({
        valid: true,
        in_range: true,
        formatted_address: rawAddress,
        note: 'Address not geocoded — no Google Maps key configured.'
      }));
    }

    const geocodeUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
    const response = await axios.get(geocodeUrl, {
      params: { address: rawAddress, key: apiKey },
      timeout: 8000
    });

    if (response.data.status !== 'OK' || response.data.results.length === 0) {
      return sendResult(res, JSON.stringify({
        valid: false,
        in_range: false,
        error: 'Could not verify that address. Please provide the full street address with city.'
      }));
    }

    const result = response.data.results[0];
    const location = result.geometry.location;

    const distance = haversineDistance(
      config.address.lat, config.address.lng,
      location.lat, location.lng
    );
    const inRange = distance <= config.delivery.max_distance_miles;

    return sendResult(res, JSON.stringify({
      valid: true,
      in_range: inRange,
      formatted_address: result.formatted_address,
      distance_miles: Math.round(distance * 10) / 10,
      max_miles: config.delivery.max_distance_miles,
      message: inRange ? null : `Address is ${Math.round(distance * 10) / 10} miles away. Max delivery distance is ${config.delivery.max_distance_miles} miles.`
    }));
  } catch (err) {
    console.error('verify_address error:', err.message);
    sendResult(res, JSON.stringify({ valid: true, in_range: true, formatted_address: req.body?.args?.raw_address || 'address', note: 'Verification unavailable, proceeding.' }));
  }
}

// ─── 12. SUBMIT ORDER ───────────────────────────────────────────────────────

app.post('/retell/function/submit_order', async (req, res) => {
  try {
    const { args, callId } = getArgs(req);
    const cart = getCart(callId);
    const tenant = loadTenant(DEFAULT_TENANT);
    if (!tenant) return sendResult(res, 'Could not submit order — configuration error.');

    const orderType = args.order_type || cart.order_type || 'pickup';
    const config = tenant.config;

    // Build Supermenu XML
    const subtotal = cart.items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0);
    const tax = Math.round(subtotal * config.tax_rate * 100) / 100;
    const deliveryFee = orderType === 'delivery' ? config.delivery.fee : 0;
    const total = Math.round((subtotal + tax + deliveryFee) * 100) / 100;

    const refNumber = Date.now() % 2147483647;
    const now = new Date();
    const timeString = formatTimestamp(now, config.hours?.timezone || 'America/New_York');

    // Build items XML
    let itemsXML = '';
    for (const item of cart.items) {
      const modStr = item.special_instructions || '';
      itemsXML += `
    <OrderLineItem>
      <itemName>${escapeXml(item.name)}</itemName>
      <foodMenuItemId>${item.item_id || ''}</foodMenuItemId>
      <quantity>${item.quantity || 1}</quantity>
      <unitPrice>${item.price.toFixed(2)}</unitPrice>
      <printKitchen>Y</printKitchen>
      ${modStr ? `<additionalRequirements>${escapeXml(modStr)}</additionalRequirements>` : ''}
    </OrderLineItem>`;
    }

    // Parse phone
    const phone = (args.customer_phone || '0000000000').replace(/\D/g, '');
    const areaCode = phone.length >= 10 ? phone.substring(0, 3) : '000';
    const phoneNum = phone.length >= 10 ? phone.substring(3) : phone;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FoodOrder>
  <referenceNumber>${refNumber}</referenceNumber>
  <timeString>${timeString}</timeString>
  <type>${orderType === 'delivery' ? 'Delivery' : 'Pick-Up'}</type>
  <comments>${escapeXml(args.special_instructions || '')}</comments>
  <payment>CASH</payment>
  <subtotal>${subtotal.toFixed(2)}</subtotal>
  <tax>${tax.toFixed(2)}</tax>
  <total>${total.toFixed(2)}</total>
  ${orderType === 'delivery' ? `<deliveryCharge>${deliveryFee.toFixed(2)}</deliveryCharge>` : ''}
  <brandName>${escapeXml(config.restaurant_name)}</brandName>
  <Customer>
    <firstName>${escapeXml(args.customer_name || 'Phone')}</firstName>
    <lastName>Order</lastName>
    <phoneAreaCode>${areaCode}</phoneAreaCode>
    <phone>${phoneNum}</phone>
    <email>phone@order.com</email>
  </Customer>
  ${orderType === 'delivery' && args.delivery_address ? `
  <Address>
    <addressLine1>${escapeXml(args.delivery_address)}</addressLine1>
  </Address>` : ''}
  <Items>${itemsXML}
  </Items>
</FoodOrder>`;

    // POST to Supermenu
    console.log('Submitting to Supermenu:', { refNumber, total, items: cart.items.length });

    const postResponse = await axios.post(config.pos.endpoint, xml, {
      params: { id: config.pos.restaurant_id, password: config.pos.password },
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000
    });

    const responseText = typeof postResponse.data === 'string' ? postResponse.data : JSON.stringify(postResponse.data);
    console.log('Supermenu response:', responseText);

    if (responseText.toLowerCase().includes('success') || postResponse.status === 200) {
      // Clear cart after successful submit
      delete carts[callId];

      const eta = orderType === 'delivery' ? '30 to 45 minutes' : '15 to 20 minutes';
      return sendResult(res, `Order submitted successfully! Reference number ${refNumber}. Estimated time: ${eta}. Total: $${total.toFixed(2)}.`);
    } else {
      return sendResult(res, `Order submission failed. Please transfer the caller to staff.`);
    }
  } catch (err) {
    console.error('submit_order error:', err.message);
    sendResult(res, 'Order submission failed due to a system error. Please transfer the caller to staff.');
  }
});

// ─── Utility Functions ──────────────────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

function escapeXml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatTimestamp(date, tz) {
  const options = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Retell Tool Server running on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /                              → health check`);
  console.log(`  POST /retell/function/search_menu   → search menu`);
  console.log(`  POST /retell/function/add_to_cart   → add item`);
  console.log(`  POST /retell/function/get_cart      → view cart`);
  console.log(`  POST /retell/function/remove_from_cart → remove item`);
  console.log(`  POST /retell/function/check_combo_deals → combo check`);
  console.log(`  POST /retell/function/calculate_total → pricing`);
  console.log(`  POST /retell/function/submit_order  → submit to POS`);
  console.log(`  POST /retell/function/verify_address → address check`);
});

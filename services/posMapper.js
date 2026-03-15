/**
 * posMapper.js — Supermenu POS XML Builder
 * 
 * Converts the priced cart (output of ComboEngine) into the exact XML
 * payload expected by the Supermenu Integration Server.
 * 
 * CRITICAL RULES:
 * 1. Combo deals = ONE OrderLineItem with Requirements for components
 * 2. Component prices inside combos are ZERO (price is on the parent)
 * 3. Standalone items = separate OrderLineItems with their own prices
 * 4. Never post combo components as separate priced line items
 */

class PosMapper {
  constructor(tenantConfig) {
    this.config = tenantConfig;
  }

  /**
   * Build the complete Supermenu XML payload.
   * 
   * @param {Object} pricedCart - Output from ComboEngine.priceOrder()
   * @param {Object} customer - Customer info {first_name, last_name, phone, email}
   * @param {string} orderType - "pickup" or "delivery"
   * @param {Object} deliveryAddress - {line1, city, state, zip} or null
   * @param {string} payment - "CASH" or "CREDIT"
   * @param {string} specialInstructions - Order-level notes
   * @returns {string} Complete XML string
   */
  buildOrderXML(pricedCart, customer, orderType, deliveryAddress, payment, specialInstructions) {
    const refNumber = this.generateReferenceNumber();
    const timeString = this.formatTimestamp(new Date());
    const type = orderType === 'delivery' ? 'Delivery' : 'Pick-Up';

    // Build items XML
    const itemsXML = this.buildItemsXML(pricedCart);

    // Build customer XML
    const customerXML = this.buildCustomerXML(customer);

    // Build address XML (only for delivery)
    const addressXML = orderType === 'delivery' && deliveryAddress
      ? this.buildAddressXML(deliveryAddress)
      : '';

    // Build delivery charge
    const deliveryChargeXML = orderType === 'delivery'
      ? `<deliveryCharge>${this.config.delivery.fee.toFixed(2)}</deliveryCharge>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<FoodOrder>
  <referenceNumber>${refNumber}</referenceNumber>
  <timeString>${timeString}</timeString>
  <type>${type}</type>
  <comments>${this.escapeXml(specialInstructions || '')}</comments>
  <payment>${payment || this.config.default_payment || 'CASH'}</payment>
  <subtotal>${pricedCart.subtotal.toFixed(2)}</subtotal>
  <tax>${pricedCart.tax.toFixed(2)}</tax>
  <total>${pricedCart.total.toFixed(2)}</total>
  ${deliveryChargeXML}
  <brandName>${this.escapeXml(this.config.restaurant_name)}</brandName>
  ${customerXML}
  ${addressXML}
  <Items>
${itemsXML}
  </Items>
</FoodOrder>`;
  }

  /**
   * Build the <Items> content with proper combo and standalone handling.
   */
  buildItemsXML(pricedCart) {
    let xml = '';

    // === COMBO LINE ITEMS ===
    // Each combo becomes ONE OrderLineItem. Components go into Requirements.
    for (const combo of (pricedCart.applied_combos || [])) {
      xml += this.buildComboLineItem(combo);
    }

    // === STANDALONE LINE ITEMS ===
    // Each standalone item gets its own OrderLineItem with its own price.
    for (const item of (pricedCart.standalone_items || [])) {
      xml += this.buildStandaloneLineItem(item);
    }

    return xml;
  }

  /**
   * Build a SINGLE OrderLineItem for a combo deal.
   * 
   * THIS IS THE MOST CRITICAL METHOD IN THE ENTIRE SYSTEM.
   * Getting this wrong means the POS charges items individually.
   */
  buildComboLineItem(combo) {
    // Total unit price = combo base price + any extra charges (e.g., extra toppings)
    const totalUnitPrice = combo.combo_price + (combo.extra_charges || 0);

    // Build additionalRequirements: human-readable summary for kitchen/receipt
    const addlReq = combo.components
      .filter(c => !c.auto_added)
      .map(c => {
        const modStr = (c.modifiers || [])
          .map(m => m.name)
          .join(', ');
        return `${this.capitalizeRole(c.role)}: ${c.name}${modStr ? ' - ' + modStr : ''}`;
      })
      .join(' | ');

    // Build Requirements: structured sub-selections for POS display
    const requirementsXML = combo.components
      .filter(c => !c.auto_added)
      .map(c => {
        const modStr = (c.modifiers || [])
          .map(m => m.name)
          .join(', ');
        const displayName = `${c.name}${modStr ? ' - ' + modStr : ''}`;
        const componentPrice = c.extra_charge || 0;

        return `      <Requirement>
        <groupName>${this.escapeXml(this.capitalizeRole(c.role))}</groupName>
        <name>${this.escapeXml(displayName)}</name>
        <quantity>1</quantity>
        <price>${componentPrice.toFixed(2)}</price>
      </Requirement>`;
      })
      .join('\n');

    return `    <OrderLineItem>
      <itemName>${this.escapeXml(combo.combo_name)}</itemName>
      <additionalRequirements>${this.escapeXml(addlReq)}</additionalRequirements>
      <quantity>1</quantity>
      <unitPrice>${totalUnitPrice.toFixed(2)}</unitPrice>
      <printKitchen>Y</printKitchen>
      <printKitchen2>Y</printKitchen2>
      <Requirements>
${requirementsXML}
      </Requirements>
    </OrderLineItem>
`;
  }

  /**
   * Build an OrderLineItem for a standalone (non-combo) item.
   */
  buildStandaloneLineItem(item) {
    let requirementsXML = '';

    if (item.modifiers && item.modifiers.length > 0) {
      const reqEntries = item.modifiers.map(m => {
        return `      <Requirement>
        <groupName>${this.escapeXml(m.group)}</groupName>
        <name>${this.escapeXml(m.name)}</name>
        <quantity>1</quantity>
        <price>${(m.price || 0).toFixed(2)}</price>
      </Requirement>`;
      }).join('\n');

      requirementsXML = `
      <Requirements>
${reqEntries}
      </Requirements>`;
    }

    const foodMenuItemIdXML = item.pos_item_id
      ? `<foodMenuItemId>${item.pos_item_id}</foodMenuItemId>`
      : '';

    return `    <OrderLineItem>
      <itemName>${this.escapeXml(item.name)}</itemName>
      ${foodMenuItemIdXML}
      <quantity>${item.quantity || 1}</quantity>
      <unitPrice>${item.price.toFixed(2)}</unitPrice>
      <printKitchen>Y</printKitchen>${requirementsXML}
    </OrderLineItem>
`;
  }

  /**
   * Build customer XML block.
   */
  buildCustomerXML(customer) {
    const phone = (customer.phone || '').replace(/\D/g, '');
    const areaCode = phone.length >= 10 ? phone.substring(0, 3) : '000';
    const phoneNum = phone.length >= 10 ? phone.substring(3) : phone;

    return `<Customer>
    <firstName>${this.escapeXml(customer.first_name || 'Phone')}</firstName>
    <lastName>${this.escapeXml(customer.last_name || 'Order')}</lastName>
    <phoneAreaCode>${areaCode}</phoneAreaCode>
    <phone>${phoneNum}</phone>
    <email>${this.escapeXml(customer.email || this.config.customer_fields?.default_email || 'phone@order.com')}</email>
  </Customer>`;
  }

  /**
   * Build address XML block for delivery orders.
   */
  buildAddressXML(address) {
    return `<Address>
    <addressLine1>${this.escapeXml(address.line1 || '')}</addressLine1>
    ${address.line2 ? `<addressLine2>${this.escapeXml(address.line2)}</addressLine2>` : ''}
    <city>${this.escapeXml(address.city || '')}</city>
    <state>${this.escapeXml(address.state || '')}</state>
    <zip>${this.escapeXml(address.zip || '')}</zip>
  </Address>`;
  }

  /**
   * Generate a unique reference number (positive integer < 2^31).
   */
  generateReferenceNumber() {
    return Date.now() % 2147483647;
  }

  /**
   * Format a Date as yyyy/MM/dd HH:mm:ss in the tenant's timezone.
   */
  formatTimestamp(date) {
    const tz = this.config.hours?.timezone || 'America/New_York';
    const options = {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };

    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';

    return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  }

  /**
   * Capitalize a combo role for display: "soda_1" → "Soda 1", "pizza" → "Pizza"
   */
  capitalizeRole(role) {
    return role
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * XML-escape a string.
   */
  escapeXml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Build the HTTP POST parameters for Supermenu.
   */
  buildPostParams(xmlPayload) {
    return {
      url: this.config.pos.endpoint,
      params: {
        id: this.config.pos.restaurant_id,
        password: this.config.pos.password
      },
      body: xmlPayload,
      contentType: 'application/xml'
    };
  }
}

module.exports = PosMapper;

/**
 * comboEngine.js — Deterministic combo detection and pricing engine
 * 
 * This module is the heart of the ordering system. It takes a conversational
 * cart and returns the optimal combo arrangement that maximizes customer savings.
 * 
 * CRITICAL: The LLM never calculates prices. This module does ALL pricing.
 */

class ComboEngine {
  constructor(menuItems, modifiers, combos, tenantConfig) {
    this.menuItems = menuItems;
    this.modifiers = modifiers;
    this.combos = combos;
    this.tenantConfig = tenantConfig;

    // Build lookup maps
    this.itemsByKey = {};
    for (const item of menuItems.items) {
      this.itemsByKey[item.item_key] = item;
    }

    this.modifierGroupsByKey = {};
    for (const group of modifiers.modifier_groups) {
      this.modifierGroupsByKey[group.group_key] = group;
    }
  }

  /**
   * Main entry point: price the entire order with combo optimization.
   */
  priceOrder(items, orderType, comboOptOuts = []) {
    // Step 1: Validate all items and modifiers
    const validationErrors = this.validateItems(items);
    if (validationErrors.length > 0) {
      return {
        valid: false,
        validation_errors: validationErrors,
        applied_combos: [],
        standalone_items: [],
        upsell_suggestion: null,
        subtotal: 0,
        tax: 0,
        delivery_fee: 0,
        total: 0,
        order_summary: ''
      };
    }

    // Step 2: Calculate individual prices for all items
    const pricedItems = items.map(item => {
      const menuItem = this.itemsByKey[item.item_key];
      const individualPrice = this.calculateItemPrice(item, menuItem);
      return {
        ...item,
        menuItem,
        individualPrice,
        tags: menuItem.combo_tags || []
      };
    });

    // Step 3: Run combo detection
    const { appliedCombos, usedItemIds } = this.detectCombos(
      pricedItems, orderType, comboOptOuts
    );

    // Step 4: Collect standalone items
    const standaloneItems = pricedItems
      .filter(item => !usedItemIds.has(item.cart_item_id))
      .map(item => ({
        cart_item_id: item.cart_item_id,
        name: item.menuItem.name,
        pos_item_id: item.menuItem.pos_item_id,
        price: item.individualPrice,
        quantity: item.quantity,
        modifiers: (item.modifiers || []).map(m => ({
          group: m.group,
          name: m.name,
          price: this.getModifierPrice(m, item.menuItem) || 0
        }))
      }));

    // Step 5: Calculate totals
    const comboSubtotal = appliedCombos.reduce(
      (sum, c) => sum + c.combo_price + (c.extra_charges || 0), 0
    );
    const standaloneSubtotal = standaloneItems.reduce(
      (sum, i) => sum + i.price * i.quantity, 0
    );
    const subtotal = Math.round((comboSubtotal + standaloneSubtotal) * 100) / 100;
    const tax = Math.round(subtotal * this.tenantConfig.tax_rate * 100) / 100;
    const deliveryFee = orderType === 'delivery'
      ? this.tenantConfig.delivery.fee
      : 0;
    const total = Math.round((subtotal + tax + deliveryFee) * 100) / 100;

    // Step 6: Check for upsell opportunities
    const upsellSuggestion = this.detectUpsell(
      pricedItems, usedItemIds, orderType, comboOptOuts
    );

    // Step 7: Build order summary
    const orderSummary = this.buildOrderSummary(
      appliedCombos, standaloneItems, subtotal, tax, deliveryFee, total
    );

    return {
      valid: true,
      validation_errors: [],
      applied_combos: appliedCombos.map(c => ({
        combo_key: c.combo_key,
        combo_name: c.combo_name,
        combo_price: c.combo_price,
        individual_price: c.individual_price,
        savings: c.savings,
        extra_charges: c.extra_charges,
        component_cart_ids: c.components.map(comp => comp.cart_item_id),
        components: c.components
      })),
      standalone_items: standaloneItems,
      upsell_suggestion: upsellSuggestion,
      subtotal,
      tax,
      delivery_fee: deliveryFee,
      total,
      order_summary: orderSummary
    };
  }

  /**
   * Validate all items have required modifiers.
   */
  validateItems(items) {
    const errors = [];

    for (const item of items) {
      const menuItem = this.itemsByKey[item.item_key];
      if (!menuItem) {
        errors.push({
          cart_item_id: item.cart_item_id,
          item_name: item.item_key,
          missing_modifier_group: null,
          prompt_question: `Item "${item.item_key}" not found in menu.`
        });
        continue;
      }

      if (!menuItem.available) {
        errors.push({
          cart_item_id: item.cart_item_id,
          item_name: menuItem.name,
          missing_modifier_group: null,
          prompt_question: `${menuItem.name} is currently unavailable.`
        });
        continue;
      }

      // Check required modifier groups
      for (const groupKey of (menuItem.required_modifier_groups || [])) {
        const group = this.modifierGroupsByKey[groupKey];
        if (!group || !group.required) continue;

        const hasModifier = (item.modifiers || []).some(
          m => m.group === groupKey
        );

        if (!hasModifier) {
          errors.push({
            cart_item_id: item.cart_item_id,
            item_name: menuItem.name,
            missing_modifier_group: groupKey,
            prompt_question: group.prompt_question
          });
        }
      }
    }

    return errors;
  }

  /**
   * Calculate the individual price of an item including modifiers.
   */
  calculateItemPrice(item, menuItem) {
    let price = menuItem.base_price;

    for (const mod of (item.modifiers || [])) {
      price += this.getModifierPrice(mod, menuItem);
    }

    return Math.round(price * 100) / 100;
  }

  /**
   * Get the price of a single modifier based on the item's size.
   */
  getModifierPrice(mod, menuItem) {
    const group = this.modifierGroupsByKey[mod.group];
    if (!group) return 0;

    // Check if group has size-based pricing (like toppings)
    if (group.price_by_size && menuItem.size) {
      const sizePrices = group.price_by_size[menuItem.size];
      if (sizePrices) {
        const option = group.options.find(o => o.name === mod.name);
        if (option && option.price_tier) {
          const isHalf = mod.half === true;
          if (option.price_tier === 'premium') {
            return isHalf ? sizePrices.premium_half : sizePrices.premium;
          } else {
            return isHalf ? sizePrices.half : sizePrices.standard;
          }
        }
      }
    }

    // Check for flat price on the option
    const option = group.options.find(o => o.name === mod.name);
    if (option && option.price !== undefined) {
      return option.price;
    }

    return 0;
  }

  /**
   * Core combo detection: greedy algorithm with priority ordering.
   */
  detectCombos(pricedItems, orderType, comboOptOuts) {
    // Filter eligible combos
    const eligibleCombos = this.combos.combos
      .filter(c => c.order_types.includes(orderType))
      .filter(c => !comboOptOuts.includes(c.combo_key))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    const appliedCombos = [];
    const usedItemIds = new Set();

    for (const comboDef of eligibleCombos) {
      // Try to match this combo repeatedly (for multiple instances)
      let matchAttempts = 0;
      const maxAttempts = 10; // Safety limit

      while (matchAttempts < maxAttempts) {
        matchAttempts++;

        const assignment = this.tryMatchCombo(comboDef, pricedItems, usedItemIds);
        if (!assignment) break;

        // Calculate savings
        const individualTotal = assignment.reduce(
          (sum, a) => sum + (a.individualPrice || 0), 0
        );
        const extraCharges = this.calculateExtraToppingCharges(assignment, comboDef);
        const comboTotal = comboDef.price + extraCharges;

        if (comboTotal < individualTotal) {
          // Combo saves money — apply it
          const components = assignment.map(a => ({
            role: a.role,
            cart_item_id: a.cart_item_id,
            auto_added: a.auto_added || false,
            name: a.menuItem ? a.menuItem.name : a.name,
            modifiers: a.modifiers || [],
            extra_charge: a.extra_charge || 0
          }));

          appliedCombos.push({
            combo_key: comboDef.combo_key,
            combo_name: comboDef.name,
            combo_price: comboDef.price,
            individual_price: Math.round(individualTotal * 100) / 100,
            savings: Math.round((individualTotal - comboTotal) * 100) / 100,
            extra_charges: Math.round(extraCharges * 100) / 100,
            components
          });

          for (const a of assignment) {
            if (!a.auto_added) {
              usedItemIds.add(a.cart_item_id);
            }
          }
        } else {
          break; // No savings, stop trying this combo
        }
      }
    }

    return { appliedCombos, usedItemIds };
  }

  /**
   * Try to match one instance of a combo definition against available items.
   */
  tryMatchCombo(comboDef, pricedItems, usedIds) {
    const assignment = [];
    const tentativelyUsed = new Set();

    for (const component of comboDef.components) {
      if (component.auto_add) {
        // Auto-added component (e.g., fries included in combo)
        assignment.push({
          role: component.role,
          cart_item_id: `auto_${component.role}_${Date.now()}`,
          auto_added: true,
          name: component.description || component.role,
          individualPrice: 0,
          modifiers: [],
          menuItem: null
        });
        continue;
      }

      // Find matching items not yet used
      const candidates = pricedItems
        .filter(i => !usedIds.has(i.cart_item_id))
        .filter(i => !tentativelyUsed.has(i.cart_item_id))
        .filter(i => i.tags.some(t => component.match_tags.includes(t)));

      if (candidates.length === 0) {
        return null; // Can't complete this combo
      }

      // Pick the most expensive candidate (maximizes savings)
      candidates.sort((a, b) => b.individualPrice - a.individualPrice);
      const best = candidates[0];

      assignment.push({
        role: component.role,
        cart_item_id: best.cart_item_id,
        individualPrice: best.individualPrice,
        menuItem: best.menuItem,
        modifiers: best.modifiers || [],
        item: best
      });
      tentativelyUsed.add(best.cart_item_id);
    }

    return assignment;
  }

  /**
   * Calculate extra topping charges beyond what's included in a combo.
   */
  calculateExtraToppingCharges(assignment, comboDef) {
    let totalExtra = 0;

    for (const assigned of assignment) {
      if (assigned.auto_added) continue;

      const roleDef = comboDef.components.find(c => c.role === assigned.role);
      if (!roleDef || roleDef.included_toppings === undefined) continue;

      const toppings = (assigned.modifiers || []).filter(m => m.group === 'toppings');
      const extraCount = Math.max(0, toppings.length - roleDef.included_toppings);

      if (extraCount > 0 && assigned.menuItem) {
        const size = assigned.menuItem.size;
        const prices = comboDef.extra_topping_prices
          ? comboDef.extra_topping_prices[size]
          : null;

        if (prices) {
          const toppingGroup = this.modifierGroupsByKey['toppings'];
          for (let i = roleDef.included_toppings; i < toppings.length; i++) {
            const topping = toppings[i];
            const option = toppingGroup
              ? toppingGroup.options.find(o => o.name === topping.name)
              : null;

            if (option && option.price_tier === 'premium') {
              totalExtra += prices.premium || 0;
            } else {
              totalExtra += prices.standard || 0;
            }
          }
        }
      }

      assigned.extra_charge = totalExtra;
    }

    return totalExtra;
  }

  /**
   * Detect upsell opportunities (near-miss combos).
   */
  detectUpsell(pricedItems, usedItemIds, orderType, comboOptOuts) {
    const unusedItems = pricedItems.filter(i => !usedItemIds.has(i.cart_item_id));
    if (unusedItems.length === 0 && pricedItems.length > 0) return null;

    const eligibleCombos = this.combos.combos
      .filter(c => c.order_types.includes(orderType))
      .filter(c => !comboOptOuts.includes(c.combo_key));

    let bestUpsell = null;
    let bestSavings = 0;

    for (const comboDef of eligibleCombos) {
      const nonAutoComponents = comboDef.components.filter(c => !c.auto_add);
      let matchedCount = 0;
      let missingComponent = null;
      const tentativelyUsed = new Set();

      for (const component of nonAutoComponents) {
        const allItems = [...pricedItems.filter(i => !usedItemIds.has(i.cart_item_id))];
        const candidate = allItems.find(i =>
          !tentativelyUsed.has(i.cart_item_id) &&
          i.tags.some(t => component.match_tags.includes(t))
        );

        if (candidate) {
          matchedCount++;
          tentativelyUsed.add(candidate.cart_item_id);
        } else {
          missingComponent = component;
        }
      }

      // One item away from completing a combo
      if (matchedCount === nonAutoComponents.length - 1 && missingComponent) {
        // Estimate savings
        const currentTotal = [...tentativelyUsed].reduce((sum, id) => {
          const item = pricedItems.find(i => i.cart_item_id === id);
          return sum + (item ? item.individualPrice : 0);
        }, 0);

        // Rough estimate of the missing item's price
        const missingItemEstimate = this.estimateMissingItemPrice(missingComponent);
        const individualTotal = currentTotal + missingItemEstimate;
        const potentialSavings = individualTotal - comboDef.price;

        if (potentialSavings > 0 && potentialSavings > bestSavings) {
          bestSavings = potentialSavings;
          bestUpsell = {
            type: 'combo_completion',
            message: `Add a ${missingComponent.description || missingComponent.role} and get the ${comboDef.name} for $${comboDef.price.toFixed(2)}`,
            combo_key: comboDef.combo_key,
            missing_item: missingComponent.description || missingComponent.role,
            potential_savings: Math.round(potentialSavings * 100) / 100
          };
        }
      }
    }

    return bestUpsell;
  }

  /**
   * Estimate the price of a missing combo component for upsell calculation.
   */
  estimateMissingItemPrice(component) {
    // Find the cheapest item matching the component's tags
    for (const item of this.menuItems.items) {
      if (item.combo_tags && item.combo_tags.some(t => component.match_tags.includes(t))) {
        return item.base_price;
      }
    }
    return 0;
  }

  /**
   * Build a human-readable order summary.
   */
  buildOrderSummary(appliedCombos, standaloneItems, subtotal, tax, deliveryFee, total) {
    const parts = [];

    for (const combo of appliedCombos) {
      const comboPrice = combo.combo_price + (combo.extra_charges || 0);
      parts.push(`${combo.combo_name} ($${comboPrice.toFixed(2)})`);
    }

    for (const item of standaloneItems) {
      parts.push(`${item.name} ($${item.price.toFixed(2)})`);
    }

    let summary = parts.join(', ');
    summary += ` — Subtotal: $${subtotal.toFixed(2)}`;
    summary += `, Tax: $${tax.toFixed(2)}`;
    if (deliveryFee > 0) {
      summary += `, Delivery: $${deliveryFee.toFixed(2)}`;
    }
    summary += `, Total: $${total.toFixed(2)}`;

    return summary;
  }
}

module.exports = ComboEngine;

// VERSION: V16-2026-03-28 — Database-backed pricing engine
var express = require("express");
var app = express();
app.use(express.json({ limit: "50mb" }));

// ═══════════════════════════════════════════════════
// DATABASE CONNECTION — loads menu into memory at startup
// Falls back to hardcoded data if database is unavailable
// ═══════════════════════════════════════════════════
var Pool = null;
var pool = null;
var DB_STATUS = "not configured";

try {
  Pool = require("pg").Pool;
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    DB_STATUS = "connecting";
    console.log("DB: Postgres pool created");
  } else {
    console.log("DB: No DATABASE_URL set — using hardcoded menu data");
    DB_STATUS = "no DATABASE_URL";
  }
} catch (e) {
  console.log("DB: pg module not installed — using hardcoded menu data. Run: npm install pg");
  DB_STATUS = "pg not installed";
}

// In-memory menu cache — populated from DB or hardcoded defaults
var MENU_CACHE = {
  items: [],
  toppings: [],
  sub_fixins: [],
  cheese_options: [],
  wing_flavors: [],
  wing_dressings: [],
  soda_flavors: [],
  salad_dressings: [],
  tender_sauces: [],
  sandwich_fixins: [],
  wrap_fixins: [],
  combo_deals: [],
  loaded_from: "defaults",
  loaded_at: null
};

async function loadMenuFromDB() {
  if (!pool) return false;
  try {
    var tables = {
      items: "SELECT * FROM menu_items WHERE active = true ORDER BY id",
      toppings: "SELECT * FROM toppings WHERE active = true ORDER BY id",
      sub_fixins: "SELECT * FROM sub_fixins WHERE active = true ORDER BY id",
      cheese_options: "SELECT * FROM cheese_options WHERE active = true ORDER BY id",
      wing_flavors: "SELECT * FROM wing_flavors WHERE active = true ORDER BY id",
      wing_dressings: "SELECT * FROM wing_dressings WHERE active = true ORDER BY id",
      soda_flavors: "SELECT * FROM soda_flavors ORDER BY id",
      salad_dressings: "SELECT * FROM salad_dressings WHERE active = true ORDER BY id",
      tender_sauces: "SELECT * FROM tender_sauces ORDER BY id",
      sandwich_fixins: "SELECT * FROM sandwich_fixins WHERE active = true ORDER BY id",
      wrap_fixins: "SELECT * FROM wrap_fixins WHERE active = true ORDER BY id",
      combo_deals: "SELECT * FROM combo_deals WHERE active = true ORDER BY id"
    };
    for (var key in tables) {
      var result = await pool.query(tables[key]);
      MENU_CACHE[key] = result.rows;
    }
    MENU_CACHE.loaded_from = "database";
    MENU_CACHE.loaded_at = new Date().toISOString();
    DB_STATUS = "connected";
    
    // Rebuild in-memory lookup structures from DB data
    rebuildLookupsFromCache();
    
    console.log("DB: Menu loaded — " + MENU_CACHE.items.length + " items, " + MENU_CACHE.toppings.length + " toppings, " + MENU_CACHE.combo_deals.length + " deals");
    return true;
  } catch (e) {
    console.error("DB: Failed to load menu —", e.message);
    DB_STATUS = "error: " + e.message;
    return false;
  }
}

function rebuildLookupsFromCache() {
  // Rebuild SUBS_DB from database
  var dbSubs = MENU_CACHE.items.filter(function(i) { return i.item_type === "sub"; });
  if (dbSubs.length > 0) {
    SUBS_DB = dbSubs.map(function(s) {
      return {
        keys: s.keywords || [],
        id: s.pos_id,
        name: s.item_name,
        p8: parseFloat(s.price_8 || 0),
        p12: parseFloat(s.price_12 || 0)
      };
    });
    // Sort by longest keyword first (so "shrimp cheese steak" matches before "cheese steak")
    SUBS_DB.sort(function(a, b) {
      var aMax = Math.max.apply(null, a.keys.map(function(k) { return k.length; }));
      var bMax = Math.max.apply(null, b.keys.map(function(k) { return k.length; }));
      return bMax - aMax;
    });
    console.log("DB: Rebuilt SUBS_DB with " + SUBS_DB.length + " subs");
  }
  
  // Rebuild TOPPING_PRICES and TOPPING_IDS from database
  if (MENU_CACHE.toppings.length > 0) {
    TOPPING_PRICES = {10:{},12:{},14:{},16:{},18:{}};
    TOPPING_IDS = {10:{},12:{},14:{},16:{},18:{}};
    FREE_TOPPINGS = [];
    
    MENU_CACHE.toppings.forEach(function(t) {
      var norm = normTopping(t.topping_name);
      if (t.is_free) {
        FREE_TOPPINGS.push(norm);
        [10,12,14,16,18].forEach(function(sz) {
          TOPPING_IDS[sz][norm] = t["mod_id_" + sz] || null;
        });
        return;
      }
      [10,12,14,16,18].forEach(function(sz) {
        TOPPING_PRICES[sz][norm] = {
          full: parseFloat(t["price_" + sz] || 0),
          half: parseFloat(t["half_price_" + sz] || 0)
        };
        TOPPING_IDS[sz][norm] = t["mod_id_" + sz] || null;
      });
    });
    console.log("DB: Rebuilt topping prices for " + MENU_CACHE.toppings.length + " toppings");
  }
  
  // Rebuild COMBO_DB from database
  if (MENU_CACHE.combo_deals.length > 0) {
    COMBO_DB = {};
    MENU_CACHE.combo_deals.forEach(function(d) {
      var dt = d.deal_type;
      if (!COMBO_DB[dt]) {
        COMBO_DB[dt] = {sizes:{}, desc: d.description, pizzas: d.pizza_count, freeToppings: d.free_toppings};
      }
      var sk = d.pizza_size || 0;
      COMBO_DB[dt].sizes[sk] = {id: d.deal_pos_id, price: parseFloat(d.price)};
      if (d.includes_fries) COMBO_DB[dt].includes_fries = true;
      if (d.includes_can) COMBO_DB[dt].includes_can = true;
      if (d.includes_2l) COMBO_DB[dt].includes_2l = true;
      if (d.wing_count > 0) COMBO_DB[dt].wings = d.wing_count;
    });
    console.log("DB: Rebuilt COMBO_DB with " + Object.keys(COMBO_DB).length + " deal types");
  }
  
  // Rebuild FIXED_ITEMS from database (non-sub, non-pizza items)
  var fixable = MENU_CACHE.items.filter(function(i) { return i.item_type !== "sub" && i.item_type !== "cheese_pizza" && i.item_type !== "specialty_pizza"; });
  if (fixable.length > 0) {
    FIXED_ITEMS = {};
    fixable.forEach(function(i) {
      (i.keywords || []).forEach(function(kw) {
        FIXED_ITEMS[kw] = i.pos_id;
      });
    });
    console.log("DB: Rebuilt FIXED_ITEMS with " + Object.keys(FIXED_ITEMS).length + " keywords");
  }
  
  // Rebuild SUB_FIXINS_IDS and prices
  if (MENU_CACHE.sub_fixins.length > 0) {
    SUB_FIXINS_IDS = {};
    SUB_FIXINS_PRICES = {};
    MENU_CACHE.sub_fixins.forEach(function(f) {
      var norm = normTopping(f.fixin_name);
      SUB_FIXINS_IDS[norm] = f.modifier_id;
      if (parseFloat(f.price) > 0) SUB_FIXINS_PRICES[norm] = parseFloat(f.price);
    });
  }
  
  // Rebuild CHEESE_IDS and prices
  if (MENU_CACHE.cheese_options.length > 0) {
    CHEESE_IDS = {};
    CHEESE_PRICES = {};
    MENU_CACHE.cheese_options.forEach(function(c) {
      var norm = normTopping(c.cheese_name);
      CHEESE_IDS[norm] = c.modifier_id;
      if (parseFloat(c.price) > 0) CHEESE_PRICES[norm] = parseFloat(c.price);
    });
  }
}

// Load menu on startup
if (pool) {
  loadMenuFromDB().then(function(ok) {
    if (!ok) console.log("DB: Using hardcoded defaults as fallback");
  });
}

// Tag constants — built via concatenation to prevent any stripping
var NT = "<" + "na" + "me" + ">";
var NTC = "</" + "na" + "me" + ">";

var CONFIG = {
  RESTAURANT_ID: process.env.RESTAURANT_ID || "80001",
  PASSWORD: process.env.PASSWORD || "ABC888",
  SUPERMENU_URL: process.env.SUPERMENU_URL || "https://www.mealage.us/aivoice/orders.jsp",
  TAX_RATE: parseFloat(process.env.TAX_RATE || "0.06"),
  DELIVERY_FEE: parseFloat(process.env.DELIVERY_FEE || "1.95"),
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "",
  RESTAURANT_LAT: parseFloat(process.env.RESTAURANT_LAT || "0"),
  RESTAURANT_LNG: parseFloat(process.env.RESTAURANT_LNG || "0"),
  MAX_DELIVERY_MILES: parseFloat(process.env.MAX_DELIVERY_MILES || "4"),
  PORT: process.env.PORT || 3000,
};

function genRef() { return Math.floor(100000 + Math.random() * 900000); }

function timeNow() {
  var d = new Date();
  function p(n) { return n < 10 ? "0" + n : "" + n; }
  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function X(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════
// ITEM ID AUTO-CORRECTION — fixes wrong IDs from agent
// Maps item_name to correct POS foodMenuItemId
// ═══════════════════════════════════════════════════

var SIZED_ITEMS = {
  // Cheese Pizzas: keyword → {size: id}
  "cheese pizza": {10:735, 12:736, 14:737, 16:738, 18:739},

  // Specialty Pizzas: keyword → {size: id} (all sizes same ID)
  "deluxe pizza": {10:655,12:655,14:655,16:655,18:655},
  "steak pizza": {10:656,12:656,14:656,16:656,18:656},
  "unique pizza": {10:657,12:657,14:657,16:657,18:657},
  "supreme pizza": {10:658,12:658,14:658,16:658,18:658},
  "veggie pizza": {10:659,12:659,14:659,16:659,18:659},
  "philly cheese steak pizza": {10:660,12:660,14:660,16:660,18:660},
  "hawaiian pizza": {10:661,12:661,14:661,16:661,18:661},
  "new york style pizza": {10:662,12:662,14:662,16:662,18:662},
  "ny style pizza": {10:662,12:662,14:662,16:662,18:662},
  "chicken bacon ranch pizza": {10:663,12:663,14:663,16:663,18:663},
  "buffalo chicken pizza": {10:664,12:664,14:664,16:664,18:664},
  "bbq chicken pizza": {10:666,12:666,14:666,16:666,18:666},
  "meal buster pizza": {10:667,12:667,14:667,16:667,18:667},
  "meat lover pizza": {10:829,12:829,14:829,16:829,18:829},

  // Grilled Subs: keyword → {8: id, 12: id}
  "cheese steak sub": {8:684,12:684},
  "cheesesteak sub": {8:684,12:684},
  "chicken cheese steak sub": {8:685,12:685},
  "chicken cheesesteak sub": {8:685,12:685},
  "cheese burger sub": {8:686,12:686},
  "cheeseburger sub": {8:686,12:686},
  "steak sub": {8:687,12:687},
  "hamburger sub": {8:688,12:688},
  "meat ball sub": {8:689,12:689},
  "meatball sub": {8:689,12:689},
  "turkey burger sub": {8:690,12:690},
  "chicken parmesan sub": {8:691,12:691},
  "chicken parm sub": {8:691,12:691},
  "grilled chicken sub": {8:692,12:692},
  "chicken fillet sub": {8:693,12:693},
  "pizza sub": {8:694,12:694},
  "chilli sub": {8:695,12:695},
  "chili sub": {8:695,12:695},
  "cheese fish sub": {8:801,12:801},
  "crab cake sub": {8:833,12:833},

  // Cold Cut Subs
  "italian cold cut sub": {8:702,12:702},
  "italian hot cut sub": {8:703,12:703},
  "turkey breast sub": {8:704,12:704},
  "ham and cheese sub": {8:705,12:705},
  "ham cheese sub": {8:705,12:705},
  "tuna salad sub": {8:706,12:706},
  "tuna sub": {8:706,12:706},
  "chicago cold cut sub": {8:707,12:707},
  "chicken salad sub": {8:708,12:708},
  "chipotle sub": {8:709,12:709},
  "shrimp salad sub": {8:710,12:710},
  "regular cold cut sub": {8:825,12:825},
  "regular hot cut sub": {8:826,12:826},
  "american cold cut sub": {8:825,12:825},
  "american cold cut": {8:825,12:825},
  "american hot cut sub": {8:826,12:826},
  "american hot cut": {8:826,12:826},

  // Special Subs
  "philly cheese steak sub": {8:723,12:723},
  "philly cheesesteak sub": {8:723,12:723},
  "philly chicken sub": {8:724,12:724},
  "cheese steak special sub": {8:725,12:725},
  "cheesesteak special sub": {8:725,12:725},
  "shrimp cheese steak sub": {8:726,12:726},
  "shrimp cheesesteak sub": {8:726,12:726},
  "veggie sub": {8:727,12:727},

  // Buffalo Wings: keyword → {count: id}
  "buffalo wing": {6:579,8:580,9:580,10:581,12:581,18:582,24:583,36:584,48:585,50:586},

  // Whole Wings
  "whole wing": {4:591,6:592,8:593,10:594,12:595,15:596,20:597,30:598},

  // Chicken Nuggets
  "chicken nugget": {6:587,9:588,12:824},

  // Fish Nuggets
  "fish nugget": {5:589,10:590},

  // Chicken Tenders
  "chicken tender": {3:672,5:673,7:674},

  // Seafood
  "tilapia": {2:642,3:643,5:644},
  "cat fish": {2:645,3:646,5:647},
  "catfish": {2:645,3:646,5:647},
  "whiting": {2:648,3:649,5:650},
  "lake trout": {3:651,5:652},
};

var FIXED_ITEMS = {
  // Sandwiches
  "crab cake sandwich": 711,
  "hamburger sandwich": 712, "hamburger 1/4": 712, "quarter pound": 712,
  "cheese burger sandwich": 713, "cheeseburger sandwich": 713, "cheeseburger": 713,
  "turkey burger sandwich": 714, "turkey burger": 714,
  "grilled chicken sandwich": 715,
  "crispy chicken sandwich": 716,
  "fried fish sandwich": 717,
  "cheese fish sandwich": 718, "cheese fish": 718,
  "blt sandwich": 719, "blt": 719,
  "hot dog": 720,
  "grilled shrimp sandwich": 721,
  "fried shrimp sandwich": 722,

  // Wraps
  "grilled chicken caesar wrap": 623, "chicken caesar wrap": 623,
  "veggie wrap": 624,
  "cheese steak wrap": 625, "cheesesteak wrap": 625,
  "chicken cheese steak wrap": 626, "chicken cheesesteak wrap": 626,
  "italian cold cut wrap": 627,
  "cheese burger wrap": 628, "cheeseburger wrap": 628,
  "buffalo chicken wrap": 629,
  "chipotle cheese steak wrap": 630, "chipotle cheesesteak wrap": 630, "chipotle wrap": 630,
  "ranchero chicken wrap": 631, "ranchero wrap": 631,
  "turkey wrap": 812,
  "tuna wrap": 813,
  "shrimp salad wrap": 814,

  // Clubs
  "turkey club": 696,
  "ham club": 697,
  "grilled chicken club": 698, "chicken club": 698,
  "blt club": 699,
  "tuna club": 700,
  "chicken salad club": 701,

  // Salads
  "greek salad": 633,
  "grilled chicken caesar salad": 634, "chicken caesar salad": 634,
  "garden salad": 635,
  "grilled chicken garden salad": 636,
  "grilled chicken salad": 637,
  "crispy chicken garden salad": 638, "crispy chicken salad": 638,
  "chef salad": 639, "chefs salad": 639, "chef's salad": 639,
  "tuna garden salad": 640, "tuna on garden salad": 640, "tuna salad": 640,
  "fried shrimp salad": 641,

  // Gyro
  "chicken gyro platter": 796,
  "lamb gyro platter": 797,
  "chicken gyro": 653,
  "lamb gyro": 654,

  // Seafood Platters
  "jumbo fried shrimp platter": 675, "shrimp platter": 675, "jumbo shrimp": 675,
  "shrimp basket": 676,
  "crab cake platter": 677,
  "lake trout platter": 820,
  "whiting platter": 821,
  "catfish platter": 822, "cat fish platter": 822,
  "tilapia platter": 823,

  // Pasta
  "marinara sauce spaghetti": 815, "marinara spaghetti": 815,
  "marinara sauce lasagna": 816, "marinara lasagna": 816,
  "chicken alfredo pasta": 576, "chicken alfredo": 576,
  "meat sauce spaghetti": 570,
  "meat sauce lasagna": 571,
  "chicken parmesan spaghetti": 572, "chicken parm spaghetti": 572,
  "chicken parmesan lasagna": 817, "chicken parm lasagna": 817,
  "meat ball spaghetti": 573, "meatball spaghetti": 573,
  "meat ball lasagna": 578, "meatball lasagna": 578,
  "mushroom spaghetti": 574,
  "mushroom lasagna": 818,
  "shrimp spaghetti": 575,
  "shrimp alfredo pasta": 577, "shrimp alfredo": 577,
  "shrimp lasagna": 819,

  // Stromboli
  "regular cheese and beef stromboli": 668, "regular stromboli": 668, "cheese and beef stromboli": 668, "beef stromboli": 668,
  "veggie stromboli": 669,
  "philly cheese steak stromboli": 670, "philly cheesesteak stromboli": 670, "philly stromboli": 670,
  "chicken stromboli": 671,

  // Quesadillas
  "chicken breast quesadilla": 678, "chicken quesadilla": 678,
  "buffalo chicken quesadilla": 679,
  "steak quesadilla": 680,
  "veggie quesadilla": 681,
  "shrimp quesadilla": 682,

  // Sides
  "french fries": 607, "fries": 607, "small fries": 607, "regular fries": 607,
  "large french fries": 830, "large fries": 830,
  "western fries small": 614, "western fries sm": 614,
  "western fries large": 608, "western fries lg": 608, "western fries": 608,
  "fries w/ gravy": 609, "fries with gravy": 609, "gravy fries": 609,
  "fries w/ cheese": 811, "fries with cheese": 811, "cheese fries": 811,
  "fries w/ nacho": 611, "fries with nacho": 611, "nacho fries": 611,
  "fries w/ mozzarella": 612, "fries with mozzarella": 612, "mozzarella fries": 612,
  "pizza fries": 615,
  "crazy fries": 613,
  "onion rings": 618,
  "mozzarella sticks": 616, "mozz sticks": 616,
  "breaded mushrooms": 617,
  "breadsticks w/ cheese": 799, "breadsticks with cheese": 799,
  "breadsticks": 620,
  "garlic bread w/ cheese": 622, "garlic bread with cheese": 622,
  "garlic bread": 621,
  "cole slaw": 619, "coleslaw": 619,
  "bag chips plain": 610, "chips plain": 610, "plain chips": 610,
  "bag chips bbq": 810, "chips bbq": 810, "bbq chips": 810,
  "nacho cheese cup": 848,
  "gravy cup": 849,

  // Desserts
  "sweet potato pie": 600,
  "cheese cake": 601, "cheesecake": 601,
  "chocolate cake": 602,
  "carrot cake": 603,
  "lemon cake": 604,
  "strawberry cheese cake": 605, "strawberry cheesecake": 605,
  "red velvet cake": 606, "red velvet": 606,
  "banana pudding": 832,
  "bean pie": 851,

  // Beverages
  "can soda": 728, "soda can": 728, "can of soda": 728,
  "2 liter soda": 790, "two liter soda": 790, "2 liter": 790, "2-liter": 790, "two liter": 790,
  "spring water": 732, "water": 732, "bottled water": 732,
  "16oz lemonade": 733, "lemonade": 733,
  "apple juice": 729,
  "orange juice": 730,
  "cranberry juice": 731,
};

// Combo deal name → ID
var DEAL_IDS = {
  "double deal": {12:786, 14:787, 16:788},
  "3 pizza special": {14:777, 16:778},
  "three pizza special": {14:777, 16:778},
  "3-pizza special": {14:777, 16:778},
  "pizza and wings": {12:781, 14:782, 16:783},
  "pizza wings": {12:781, 14:782, 16:783},
  "family deal": {12:781, 14:782, 16:783},
  "pizza and sub": {12:784, 14:794, 16:744},
  "pizza sub combo": {12:784, 14:794, 16:744},
  "pizza sub deal": {12:784, 14:794, 16:744},
  "combo deal": {12:769, 14:770},
  "pizza sub wings": {12:769, 14:770},
  "wings and sub": {0:771}, "wings sub combo": {0:771},
  "sub combo": {8:772, 12:774}, "sub deal": {8:772, 12:774},
  "2 sub combo": {0:773}, "two sub combo": {0:773},
  "3 sub combo": {0:780}, "three sub combo": {0:780},
  "6 buffalo wings combo": {0:840}, "wings special buffalo": {0:840},
  "4 whole wings combo": {0:839}, "wings special whole": {0:839},
  "chicken box whole": {0:838},
  "chicken box buffalo": {0:847},
  "burger combo": {0:793}, "cheeseburger combo": {0:793},
  "fish combo": {0:831}, "cheese fish combo": {0:831},
  "party deal": {0:776},
  "fish and wings deal": {0:775}, "fish wings deal": {0:775},
};

function extractNumber(str) {
  var m = str.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function fixItemId(item) {
  var nm = (item.item_name || item.component_name || item.name || "").toLowerCase()
    .replace(/[""\-]/g, " ").replace(/\s+/g, " ").trim();
  var num = extractNumber(nm);

  // 1. Try combo deal names first
  if (item.is_combo) {
    for (var deal in DEAL_IDS) {
      if (nm.indexOf(deal) !== -1) {
        var dmap = DEAL_IDS[deal];
        // Try to find pizza size from components
        var pSize = 0;
        if (item.components) {
          for (var ci = 0; ci < item.components.length; ci++) {
            var cn = (item.components[ci].component_name || "").toLowerCase();
            if (cn.indexOf("pizza") !== -1) { pSize = extractNumber(cn); break; }
          }
        }
        if (!pSize) pSize = num;
        var did = dmap[pSize] || dmap[0] || null;
        if (did) { item.item_id = String(did); console.log("ID-FIX: " + nm + " → " + did); return; }
      }
    }
  }

  // 2. Try sized items (pizza, subs, wings, nuggets, fish)
  for (var key in SIZED_ITEMS) {
    if (nm.indexOf(key) !== -1) {
      var smap = SIZED_ITEMS[key];
      // Try extracted number first, then common size aliases
      var sid = smap[num] || null;
      if (!sid) {
        if (nm.indexOf("small") !== -1 || nm.indexOf("sm ") !== -1) sid = smap[10] || smap[8] || smap[6] || smap[3] || smap[2];
        else if (nm.indexOf("medium") !== -1 || nm.indexOf("med ") !== -1) sid = smap[12] || smap[9];
        else if (nm.indexOf("large") !== -1 || nm.indexOf("lrg") !== -1) sid = smap[14];
        else if (nm.indexOf("x-large") !== -1 || nm.indexOf("xl ") !== -1 || nm.indexOf("extra large") !== -1) sid = smap[16];
        else if (nm.indexOf("xx-large") !== -1 || nm.indexOf("xxl") !== -1) sid = smap[18];
        else if (nm.indexOf("half") !== -1) sid = smap[8];
        else if (nm.indexOf("whole") !== -1 && smap[12]) sid = smap[12];
      }
      if (sid) { item.item_id = String(sid); console.log("ID-FIX: " + nm + " → " + sid); return; }
    }
  }

  // 3. Try fixed items (single-size items)
  for (var fkey in FIXED_ITEMS) {
    if (nm.indexOf(fkey) !== -1) {
      item.item_id = String(FIXED_ITEMS[fkey]);
      console.log("ID-FIX: " + nm + " → " + FIXED_ITEMS[fkey]);
      return;
    }
  }

  // 4. No match — clear bad ID so POS uses itemName instead
  if (item.item_id && !/^\d+$/.test(String(item.item_id))) {
    console.log("ID-CLEAR: " + nm + " had non-numeric ID: " + item.item_id);
    item.item_id = "";
  } else {
    console.log("ID-KEEP: " + nm + " → " + (item.item_id || "none"));
  }
}

function fixAllIds(order) {
  if (!order.items) return;
  for (var i = 0; i < order.items.length; i++) {
    var item = order.items[i];
    fixItemId(item);
    // Fix component IDs too
    if (item.components && item.components.length > 0) {
      for (var c = 0; c < item.components.length; c++) {
        fixItemId(item.components[c]);
      }
    }
  }
}

// Kitchen printer routing — explicit item IDs
// Kitchen 2 (printKitchen2): Pizzas and Stromboli
// Kitchen 1 (printKitchen): Everything else
// Tags are OMITTED (not set to N) for the printer that doesn't apply

// All Kitchen 2 item IDs:
var KITCHEN2_IDS = {
  // Cheese Pizzas
  735:1, 736:1, 737:1, 738:1, 739:1,
  // Specialty Pizzas
  655:1, 656:1, 657:1, 658:1, 659:1, 660:1, 661:1, 662:1, 663:1, 664:1, 666:1, 667:1, 829:1,
  // Stromboli
  668:1, 669:1, 670:1, 671:1
};

function isKitchen2(item) {
  var id = parseInt(item.item_id || 0);
  if (KITCHEN2_IDS[id]) return true;
  // Fallback: check category
  var cat = (item.category || "").toLowerCase();
  if (cat === "pizzas" || cat === "stromboli") return true;
  // Fallback: check name
  var nm = (item.item_name || item.name || item.component_name || "").toLowerCase();
  if (nm.indexOf("pizza") !== -1 || nm.indexOf("stromboli") !== -1) return true;
  return false;
}

function getComboKitchenTags(item) {
  var hasK1 = false, hasK2 = false;
  if (item.components && item.components.length > 0) {
    for (var c = 0; c < item.components.length; c++) {
      if (isKitchen2(item.components[c])) hasK2 = true;
      else hasK1 = true;
    }
  }
  if (!hasK1 && !hasK2) { hasK1 = true; }
  // Only send Y tags, omit the other printer entirely
  var tags = "";
  if (hasK1) tags += "<printKitchen>Y</printKitchen>";
  if (hasK2) tags += "<printKitchen2>Y</printKitchen2>";
  return tags;
}

// Build a single regular item
function buildRegularItem(item) {
  var o = "<OrderLineItem>";
  o += "<itemName>" + X(item.item_name || item.name || "Item") + "</itemName>";
  if (item.special_instructions) {
    o += "<additionalRequirements>" + X(item.special_instructions) + "</additionalRequirements>";
  }
  if (item.item_id && /^\d+$/.test(String(item.item_id))) {
    o += "<foodMenuItemId>" + X(item.item_id) + "</foodMenuItemId>";
  }
  o += "<quantity>" + (item.quantity || 1) + "</quantity>";
  o += "<unitPrice>" + parseFloat(item.unit_price || item.price || 0).toFixed(2) + "</unitPrice>";
  if (isKitchen2(item)) {
    o += "<printKitchen2>Y</printKitchen2>";
  } else {
    o += "<printKitchen>Y</printKitchen>";
  }

  if (item.modifiers && item.modifiers.length > 0) {
    o += "<Requirements>";
    for (var i = 0; i < item.modifiers.length; i++) {
      var mod = item.modifiers[i];
      var regModPrice = parseFloat(mod.price || 0);
      var regModDisplay = mod.name || mod;
      if (regModPrice > 0) regModDisplay += " +$" + regModPrice.toFixed(2);
      o += "<Requirement>";
      if (mod.group) o += "<groupMame>" + X(mod.group) + "</groupMame>";
      o += NT + X(regModDisplay) + NTC;
      o += "<quantity>1</quantity>";
      o += "<price>0.00</price>";
      o += "</Requirement>";
    }
    o += "</Requirements>";
  }
  o += "</OrderLineItem>";
  return o;
}

// Build combo: first line = combo deal (with combo price + ID), then each component as its own OrderLineItem at $0
function buildComboItems(item) {
  var o = "";

  // Line 1: Combo deal name with full price — no details, just the deal
  o += "<OrderLineItem>";
  o += "<itemName>" + X(item.item_name || "Combo Deal") + "</itemName>";
  if (item.special_instructions) {
    o += "<additionalRequirements>" + X(item.special_instructions) + "</additionalRequirements>";
  }
  if (item.item_id && /^\d+$/.test(String(item.item_id))) {
    o += "<foodMenuItemId>" + X(item.item_id) + "</foodMenuItemId>";
  }
  o += "<quantity>1</quantity>";
  o += "<unitPrice>" + parseFloat(item.unit_price || item.price || 0).toFixed(2) + "</unitPrice>";
  o += getComboKitchenTags(item);
  o += "</OrderLineItem>";

  // Lines 2+: Each component as its own OrderLineItem at $0 with details
  if (item.components && item.components.length > 0) {
    for (var c2 = 0; c2 < item.components.length; c2++) {
      var comp2 = item.components[c2];
      if (!comp2.item_id || !/^\d+$/.test(String(comp2.item_id))) continue;

      o += "<OrderLineItem>";
      o += "<itemName>" + X(comp2.component_name) + "</itemName>";
      if (comp2.special_instructions) {
        o += "<additionalRequirements>" + X(comp2.special_instructions) + "</additionalRequirements>";
      }
      o += "<foodMenuItemId>" + X(comp2.item_id) + "</foodMenuItemId>";
      o += "<quantity>1</quantity>";
      o += "<unitPrice>0.00</unitPrice>";
      if (isKitchen2(comp2)) {
        o += "<printKitchen2>Y</printKitchen2>";
      } else {
        o += "<printKitchen>Y</printKitchen>";
      }

      if (comp2.modifiers && comp2.modifiers.length > 0) {
        o += "<Requirements>";
        for (var m2 = 0; m2 < comp2.modifiers.length; m2++) {
          var mod2 = comp2.modifiers[m2];
          var mod2Price = parseFloat(mod2.price || 0);
          var mod2Display = mod2.name || "";
          if (mod2Price > 0) mod2Display += " +$" + mod2Price.toFixed(2);
          o += "<Requirement>";
          if (mod2.group) o += "<groupMame>" + X(mod2.group) + "</groupMame>";
          o += NT + X(mod2Display) + NTC;
          o += "<quantity>1</quantity>";
          o += "<price>0.00</price>";
          o += "</Requirement>";
        }
        o += "</Requirements>";
      }
      o += "</OrderLineItem>";
    }
  }

  return o;
}

function buildXml(order) {
  var ref = genRef();
  var sub = parseFloat(order.subtotal || 0);
  var tax = parseFloat(order.tax || (sub * CONFIG.TAX_RATE));
  var del = order.order_type === "delivery" ? CONFIG.DELIVERY_FEE : 0;
  var tot = parseFloat(order.total || (sub + tax + del));
  var type = order.order_type === "delivery" ? "Delivery" : "Pick-Up";
  var nm = (order.customer_name || "Guest").trim().split(/\s+/);
  var ph = (order.customer_phone || "0000000000").replace(/\D/g, "");

  var o = "<FoodOrder>";
  o += "<referenceNumber>" + ref + "</referenceNumber>";
  o += "<timeString>" + timeNow() + "</timeString>";
  o += "<type>" + type + "</type>";
  o += "<comments>" + X(order.special_instructions || order.comments || "") + "</comments>";
  o += "<payment>" + X(order.payment_method === "card" ? "CREDIT CARD" : "CASH") + "</payment>";
  o += "<subtotal>" + sub.toFixed(2) + "</subtotal>";
  o += "<tax>" + tax.toFixed(2) + "</tax>";
  o += "<total>" + tot.toFixed(2) + "</total>";
  if (del > 0) o += "<deliveryCharge>" + del.toFixed(2) + "</deliveryCharge>";
  o += "<Customer>";
  o += "<firstName>" + X(nm[0] || "Guest") + "</firstName>";
  o += "<lastName>" + X(nm.slice(1).join(" ") || "Order") + "</lastName>";
  o += "<phoneAreaCode>" + ph.substring(0, 3) + "</phoneAreaCode>";
  o += "<phone>" + ph.substring(3) + "</phone>";
  o += "<email>order@aivoice.com</email>";
  if (order.order_type === "delivery" && order.delivery_address) {
    // Parse address parts: "123 Main St, Baltimore, MD 21223" or just "123 Main St 21223"
    var addrRaw = order.delivery_address || "";
    var addrParts = addrRaw.split(",").map(function(s) { return s.trim(); });
    var street1 = addrParts[0] || addrRaw;
    var city = addrParts[1] || order.delivery_city || process.env.DEFAULT_CITY || "Baltimore";
    var stateZip = (addrParts[2] || "").trim().split(/\s+/);
    var state = order.delivery_state || stateZip[0] || process.env.DEFAULT_STATE || "MD";
    var zip = order.delivery_zip || stateZip[1] || (addrParts[3] || "").trim();
    // If no zip found in parsed parts, try extracting 5-digit zip from raw address
    if (!zip) { var zipMatch = addrRaw.match(/\b(\d{5})\b/); if (zipMatch) zip = zipMatch[1]; }
    o += "<Address>";
    o += "<addressLine1>" + X(street1) + "</addressLine1>";
    o += "<addressLine2></addressLine2>";
    o += "<city>" + X(city) + "</city>";
    o += "<state>" + X(state) + "</state>";
    o += "<zip>" + X(zip) + "</zip>";
    o += "</Address>";
  }
  o += "</Customer>";
  o += "<Items>";
  // Fix all item IDs before building XML
  fixAllIds(order);
  if (order.items && order.items.length > 0) {
    for (var i = 0; i < order.items.length; i++) {
      var item = order.items[i];
      if (item.is_combo && item.components && item.components.length > 0) {
        o += buildComboItems(item);
      } else {
        o += buildRegularItem(item);
      }
    }
  }
  o += "</Items></FoodOrder>";
  return { xml: o, ref: ref };
}

async function sendToPOS(xml) {
  var url = CONFIG.SUPERMENU_URL + "?id=" + CONFIG.RESTAURANT_ID + "&password=" + CONFIG.PASSWORD;
  var last = "";
  var types = ["text/xml; charset=utf-8", "application/xml; charset=utf-8", "application/x-www-form-urlencoded"];
  for (var a = 0; a < types.length; a++) {
    try {
      var body = a === 2 ? "xml=" + encodeURIComponent(xml) : xml;
      var r = await fetch(url, { method: "POST", headers: { "Content-Type": types[a] }, body: body });
      var t = await r.text();
      last = "attempt" + (a + 1) + " status=" + r.status + " body=" + t;
      console.log("POS " + last);
      if (t.toLowerCase().indexOf("success") !== -1) return { ok: true, response: t };
    } catch (e) { last = "attempt" + (a + 1) + " error=" + e.message; console.log("POS " + last); }
  }
  return { ok: false, response: last };
}

var orderLog = [];

// ═══════════════════════════════════════════════════
// ROUTE: Get caller ID (returns phone number to agent)
// ═══════════════════════════════════════════════════
app.post("/retell/function/get_caller_id", function (req, res) {
  var callObj = req.body.call || {};
  var phone = callObj.from_number || callObj.caller_number || callObj.user_phone || "";
  phone = phone.replace(/^\+1/, "").replace(/\D/g, "");
  console.log("\n=== GET CALLER ID ===");
  console.log("Raw call object keys:", Object.keys(callObj).join(", "));
  console.log("Extracted phone:", phone);
  if (phone.length === 10) {
    var formatted = "(" + phone.substring(0, 3) + ") " + phone.substring(3, 6) + "-" + phone.substring(6);
    res.json("PHONE: " + formatted);
  } else if (phone.length > 0) {
    res.json("PHONE: " + phone);
  } else {
    res.json("NO_PHONE: Could not detect caller ID. Ask the caller for their phone number.");
  }
});

app.post("/retell/function/submit_order", async function (req, res) {
  var log = { time: new Date().toISOString() };
  try {
    var data = req.body.args || req.body;

    // AUTO-EXTRACT caller phone from Retell call object
    var callObj = req.body.call || {};
    var callerPhone = callObj.from_number || callObj.caller_number || callObj.user_phone || "";
    // Clean: remove +1 country code prefix if present
    callerPhone = callerPhone.replace(/^\+1/, "").replace(/\D/g, "");

    // Use caller ID as customer phone if agent didn't collect one
    if (!data.customer_phone || data.customer_phone === "0000000000" || data.customer_phone === "") {
      data.customer_phone = callerPhone;
    }

    log.caller_phone_from_retell = callerPhone;
    log.args = data;

    // BUILD ITEM SUMMARY for easy verification
    var itemSummary = [];
    if (data.items && data.items.length > 0) {
      for (var s = 0; s < data.items.length; s++) {
        var si = data.items[s];
        var entry = {
          name: si.item_name || si.name || "?",
          id: si.item_id || "none",
          qty: si.quantity || 1,
          price: si.unit_price || si.price || 0,
          is_combo: !!si.is_combo,
          modifiers: [],
          components: [],
        };
        if (si.modifiers) {
          for (var sm = 0; sm < si.modifiers.length; sm++) {
            entry.modifiers.push((si.modifiers[sm].group || "") + ": " + (si.modifiers[sm].name || ""));
          }
        }
        if (si.is_combo && si.components) {
          for (var sc = 0; sc < si.components.length; sc++) {
            var comp = si.components[sc];
            var compEntry = { name: comp.component_name || "?", id: comp.item_id || "none", modifiers: [] };
            if (comp.modifiers) {
              for (var cm = 0; cm < comp.modifiers.length; cm++) {
                compEntry.modifiers.push((comp.modifiers[cm].group || "") + ": " + (comp.modifiers[cm].name || ""));
              }
            }
            entry.components.push(compEntry);
          }
        }
        itemSummary.push(entry);
      }
    }
    log.item_count = itemSummary.length;
    log.item_summary = itemSummary;
    log.payment_method = data.payment_method || "cash";
    log.customer_name = data.customer_name || "?";
    log.order_type = data.order_type || "?";
    log.total = data.total || 0;

    // ═══ SERVER-SIDE VALIDATION — reject fabricated data ═══
    var VALID_DEAL_IDS = {769:1,770:1,771:1,772:1,773:1,774:1,775:1,776:1,777:1,778:1,780:1,781:1,782:1,783:1,784:1,786:1,787:1,788:1,793:1,794:1,831:1,838:1,839:1,840:1,744:1,847:1};
    var validationErrors = [];

    if (data.items && data.items.length > 0) {
      for (var v = 0; v < data.items.length; v++) {
        var vi = data.items[v];
        var vid = String(vi.item_id || "");
        var vname = (vi.item_name || "").toLowerCase();
        var vprice = parseFloat(vi.unit_price || 0);

        // 1. Reject made-up item IDs (non-numeric or clearly fake like 1001, 1002, 1003)
        if (vid && !/^\d+$/.test(vid)) {
          validationErrors.push("Item '" + vi.item_name + "' has non-numeric ID: " + vid);
        }
        if (parseInt(vid) >= 1000 && parseInt(vid) <= 1099 && !VALID_DEAL_IDS[parseInt(vid)]) {
          validationErrors.push("Item '" + vi.item_name + "' has fabricated ID: " + vid + ". Use calculate_price or calculate_combo to get the correct ID.");
        }

        // 2. Combo items MUST have been through calculate_combo (valid deal_id)
        if (vi.is_combo) {
          if (!vid || !VALID_DEAL_IDS[parseInt(vid)]) {
            // Try to fix from DEAL_IDS map
            var dealFix = null;
            for (var dk in DEAL_IDS) {
              if (vname.indexOf(dk) !== -1) { dealFix = DEAL_IDS[dk]; break; }
            }
            if (dealFix) {
              // Try to find the right size-specific ID
              var sizeMatch = vname.match(/(\d+)\s*inch/);
              var dealSize = sizeMatch ? parseInt(sizeMatch[1]) : 0;
              if (typeof dealFix === "object" && dealFix[dealSize]) {
                vi.item_id = String(dealFix[dealSize]);
                console.log("VALIDATE-FIX: " + vname + " ID " + vid + " → " + vi.item_id);
              } else if (typeof dealFix === "object" && dealFix[0]) {
                vi.item_id = String(dealFix[0]);
                console.log("VALIDATE-FIX: " + vname + " ID " + vid + " → " + vi.item_id);
              } else if (typeof dealFix === "number") {
                vi.item_id = String(dealFix);
                console.log("VALIDATE-FIX: " + vname + " ID " + vid + " → " + vi.item_id);
              } else {
                validationErrors.push("Combo '" + vi.item_name + "' has invalid deal ID: " + vid + ". Call calculate_combo first.");
              }
            } else {
              validationErrors.push("Combo '" + vi.item_name + "' has invalid deal ID: " + vid + ". Call calculate_combo first.");
            }
          }

          // 3. Combo price validation — check against known deal prices
          var comboDB = COMBO_DB || {};
          for (var cdk in comboDB) {
            if (vname.indexOf(cdk) !== -1 || (comboDB[cdk].desc && vname.indexOf(cdk.replace(/ /g,"")) !== -1)) {
              var cdeal = comboDB[cdk];
              if (cdeal.sizes) {
                var sizeMatch2 = vname.match(/(\d+)\s*inch/);
                var ds = sizeMatch2 ? parseInt(sizeMatch2[1]) : 0;
                var dse = cdeal.sizes[ds] || cdeal.sizes[0];
                if (dse && vprice < dse.price) {
                  validationErrors.push("Combo '" + vi.item_name + "' price " + vprice + " is below base price " + dse.price + ". Call calculate_combo for correct pricing.");
                }
              }
              break;
            }
          }
        }

        // 4. Regular item price validation — $0 items are suspicious
        if (!vi.is_combo && vprice <= 0 && vname.indexOf("fries") === -1 && vname.indexOf("soda") === -1) {
          validationErrors.push("Item '" + vi.item_name + "' has $0 price. Call calculate_price first.");
        }

        // 5. Check for missing customer name
        if (!data.customer_name || data.customer_name === "?" || data.customer_name.toLowerCase() === "customer") {
          if (validationErrors.indexOf("Missing customer name. Ask the caller for their name.") === -1) {
            validationErrors.push("Missing customer name. Ask the caller for their name.");
          }
        }
      }
    }

    // Return errors to agent — force it to use tools
    if (validationErrors.length > 0) {
      console.log("VALIDATION FAILED:", validationErrors);
      log.status = "VALIDATION_FAILED";
      log.validation_errors = validationErrors;
      orderLog.unshift(log); if (orderLog.length > 50) orderLog.pop();
      return res.json("ERROR: Order rejected. " + validationErrors.join(" | ") + " Fix these issues and try again.");
    }
    // ═══ END VALIDATION ═══

    console.log("\n=== RETELL ORDER ===");
    console.log("Caller Phone (auto):", callerPhone);
    console.log("Items:", itemSummary.length);
    console.log(JSON.stringify(data, null, 2));
    var built = buildXml(data);
    log.xml = built.xml;
    log.ref = built.ref;
    console.log("\n=== XML ===\n" + built.xml);
    var result = await sendToPOS(built.xml);
    log.pos = result;
    log.status = result.ok ? "OK" : "FAIL";
    res.json(result.ok ? "Order placed! Ref " + built.ref + ". " + result.response : "Order ref " + built.ref + ". POS: " + result.response);
  } catch (e) {
    log.status = "ERROR"; log.error = e.message;
    console.error("ERROR:", e);
    res.json("Order noted. Staff will process shortly.");
  }
  orderLog.unshift(log); if (orderLog.length > 50) orderLog.pop();
});

// ═══════════════════════════════════════════════════
// ROUTE: Process card payment (USAePay REST API)
// ═══════════════════════════════════════════════════
var crypto = require("crypto");

function usaepayAuth() {
  var key = process.env.USAEPAY_KEY || "";
  var pin = process.env.USAEPAY_PIN || "";
  if (!key || !pin) return null;
  var seed = crypto.randomBytes(16).toString("hex");
  var prehash = key + seed + pin;
  var hash = crypto.createHash("sha256").update(prehash).digest("hex");
  var apiHash = "s2/" + seed + "/" + hash;
  return "Basic " + Buffer.from(key + ":" + apiHash).toString("base64");
}

var USAEPAY_URL = process.env.USAEPAY_URL || "https://sandbox.usaepay.com/api/v2";
var paymentLog = [];

app.post("/retell/function/process_payment", async function (req, res) {
  var plog = { time: new Date().toISOString(), last4: "", amount: "", status: "", reason: "", refnum: "", authcode: "", error_code: "" };
  try {
    var data = req.body.args || req.body;
    console.log("\n=== PROCESS PAYMENT ===");
    console.log(JSON.stringify(data, null, 2));

    var auth = usaepayAuth();
    if (!auth) {
      plog.status = "CONFIG_ERROR"; plog.reason = "No API key";
      paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop();
      return res.json("ERROR: Payment system not configured. Please pay cash at pickup/delivery.");
    }

    // Clean card number (remove spaces/dashes from voice transcription)
    var cardNum = (data.card_number || "").replace(/[\s\-]/g, "");
    var exp = (data.expiration || "").replace(/[\s\/\-]/g, "");
    // Convert "1228" or "122028" to "1228" (MMYY)
    if (exp.length === 6) exp = exp.substring(0, 2) + exp.substring(4, 6);
    var cvv = (data.cvv || "").replace(/\D/g, "");
    var zip = (data.zip || "").replace(/\D/g, "");
    var amount = parseFloat(data.amount || 0).toFixed(2);
    var invoice = data.invoice || "ORD-" + Date.now();

    plog.last4 = cardNum.slice(-4);
    plog.amount = amount;
    plog.invoice = invoice;

    // Validate
    if (cardNum.length < 13 || cardNum.length > 19) { plog.status = "INVALID"; plog.reason = "Bad card number length: " + cardNum.length; paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop(); return res.json("ERROR: Invalid card number. Please ask for the card number again."); }
    if (exp.length !== 4) { plog.status = "INVALID"; plog.reason = "Bad expiration: " + exp; paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop(); return res.json("ERROR: Invalid expiration. Need month and year like 12/28."); }
    if (cvv.length < 3 || cvv.length > 4) { plog.status = "INVALID"; plog.reason = "Bad CVV length: " + cvv.length; paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop(); return res.json("ERROR: Invalid CVV. Need the 3 or 4 digit code on the back of the card."); }
    if (parseFloat(amount) <= 0) { plog.status = "INVALID"; plog.reason = "Bad amount: " + amount; paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop(); return res.json("ERROR: Invalid amount."); }

    var body = {
      command: "sale",
      amount: amount,
      invoice: invoice,
      creditcard: {
        number: cardNum,
        expiration: exp,
        cvc: cvv,
        avs_zip: zip,
      },
    };

    console.log("USAePay request:", JSON.stringify({ ...body, creditcard: { ...body.creditcard, number: "****" + cardNum.slice(-4), cvc: "***" } }));

    var r = await fetch(USAEPAY_URL + "/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body: JSON.stringify(body),
    });

    var result = await r.json();
    console.log("USAePay response:", JSON.stringify(result));

    plog.refnum = result.refnum || "";
    plog.authcode = result.authcode || "";
    plog.error_code = result.error_code || "";
    plog.card_type = (result.creditcard && result.creditcard.type) || "";
    plog.avs = (result.avs && result.avs.result_code) || "";
    plog.cvc_result = (result.cvc && result.cvc.result_code) || "";

    if (result.result_code === "A") {
      plog.status = "APPROVED"; plog.reason = result.result || "Approved";
      paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop();
      return res.json("SUCCESS: Payment approved. Auth code: " + (result.authcode || "") + ". Ref: " + (result.refnum || "") + ". Last 4: " + cardNum.slice(-4));
    } else if (result.result_code === "D") {
      // Map bank error codes to customer-friendly messages
      var errMsg = (result.error || "").toLowerCase();
      var friendly = "your bank declined the card";
      if (errMsg.indexOf("insufficient") !== -1 || errMsg.indexOf("(51)") !== -1) friendly = "there are insufficient funds on the card";
      else if (errMsg.indexOf("expired") !== -1 || errMsg.indexOf("(54)") !== -1) friendly = "the card appears to be expired";
      else if (errMsg.indexOf("invalid") !== -1 || errMsg.indexOf("(14)") !== -1) friendly = "the card number doesn't seem to be valid";
      else if (errMsg.indexOf("restricted") !== -1 || errMsg.indexOf("(62)") !== -1) friendly = "the card is restricted by your bank";
      else if (errMsg.indexOf("do not honor") !== -1 || errMsg.indexOf("(05)") !== -1) friendly = "your bank declined the transaction";
      else if (errMsg.indexOf("not entitled") !== -1 || errMsg.indexOf("(63)") !== -1) friendly = "the card is not authorized for this type of transaction";
      else if (errMsg.indexOf("lost") !== -1 || errMsg.indexOf("(41)") !== -1) friendly = "the card has been reported lost";
      else if (errMsg.indexOf("stolen") !== -1 || errMsg.indexOf("(43)") !== -1) friendly = "the card has been reported stolen";
      else if (errMsg.indexOf("limit") !== -1 || errMsg.indexOf("exceed") !== -1) friendly = "the card has exceeded its limit";
      else if (errMsg.indexOf("pin") !== -1) friendly = "there's a PIN issue with the card";
      else if (errMsg.indexOf("cvv") !== -1 || errMsg.indexOf("cvc") !== -1 || errMsg.indexOf("(97)") !== -1) friendly = "the security code doesn't match";

      plog.status = "DECLINED"; plog.reason = result.error || result.result || "Declined";
      paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop();
      return res.json("DECLINED: Tell the caller: " + friendly + ". Then ask: would you like to try another card or pay cash?");
    } else if (result.result_code === "E") {
      plog.status = "ERROR"; plog.reason = result.error || result.result || "Error";
      paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop();
      return res.json("ERROR: " + (result.error || result.result || "Processing error") + ". Ask to try again or pay cash.");
    } else {
      plog.status = "UNKNOWN"; plog.reason = result.error || result.result || "Unknown";
      paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop();
      return res.json("ERROR: " + (result.result || "Unknown error") + ". Suggest cash payment.");
    }
  } catch (e) {
    plog.status = "EXCEPTION"; plog.reason = e.message;
    paymentLog.unshift(plog); if (paymentLog.length > 20) paymentLog.pop();
    console.error("Payment error:", e);
    return res.json("ERROR: Payment system unavailable. Please pay cash at pickup/delivery.");
  }
});

// Payment log viewer
app.get("/payment-log", function (req, res) {
  res.json({ total: paymentLog.length, payments: paymentLog });
});

// Test payment endpoint (uses sandbox test card)
app.get("/test-payment", async function (req, res) {
  var auth = usaepayAuth();
  if (!auth) return res.json({ error: "Set USAEPAY_KEY and USAEPAY_PIN in Render env vars" });

  var body = {
    command: "sale",
    amount: "1.00",
    invoice: "TEST-" + Date.now(),
    creditcard: { number: "4000100011112224", expiration: "0928", cvc: "123", avs_zip: "21223" },
  };

  try {
    var r = await fetch(USAEPAY_URL + "/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body: JSON.stringify(body),
    });
    var result = await r.json();
    res.json({ version: "V15", usaepay_url: USAEPAY_URL, result: result });
  } catch (e) { res.json({ error: e.message }); }
});

app.post("/retell/function/verify_address", async function (req, res) {
  try {
    var data = req.body.args || req.body;
    var addr = data.address;
    console.log("\n=== VERIFY ADDRESS ===");
    console.log("Input:", addr);

    if (!addr || addr.trim().length < 3) return res.json("INVALID: No address provided. Ask for street address and zip.");
    if (!CONFIG.GOOGLE_MAPS_API_KEY) return res.json("FOUND: Address accepted. " + addr);

    // Default city/state from env vars (set per restaurant)
    var defaultCity = process.env.DEFAULT_CITY || "Baltimore";
    var defaultState = process.env.DEFAULT_STATE || "MD";
    var lowerAddr = addr.toLowerCase();
    var hasCity = lowerAddr.indexOf(defaultCity.toLowerCase()) !== -1;

    // Always try with default city/state first, then as-is
    var clean = addr.replace(/\s+/g, " ").trim();
    var variations = [];
    if (!hasCity) {
      variations.push(clean + ", " + defaultCity + ", " + defaultState);
      variations.push(clean + ", " + defaultState);
    }
    variations.push(clean);
    variations.push(clean + ", USA");

    console.log("Trying variations:", variations);

    for (var v = 0; v < variations.length; v++) {
      try {
        var r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(variations[v]) + "&key=" + CONFIG.GOOGLE_MAPS_API_KEY);
        var geo = await r.json();
        console.log("Variation " + (v+1) + " (" + variations[v] + "): " + geo.status + " results=" + (geo.results ? geo.results.length : 0));

        if (geo.status === "OK" && geo.results && geo.results.length > 0) {
          var place = geo.results[0];
          var fmt = place.formatted_address;
          var loc = place.geometry.location;

          // Check delivery distance
          if (CONFIG.RESTAURANT_LAT !== 0) {
            var R = 3958.8;
            var dLat = ((loc.lat - CONFIG.RESTAURANT_LAT) * Math.PI) / 180;
            var dLng = ((loc.lng - CONFIG.RESTAURANT_LNG) * Math.PI) / 180;
            var a2 = Math.sin(dLat / 2) ** 2 + Math.cos(CONFIG.RESTAURANT_LAT * Math.PI / 180) * Math.cos(loc.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
            var dist = Math.round(R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2)) * 10) / 10;
            if (dist > CONFIG.MAX_DELIVERY_MILES) {
              return res.json("OUT_OF_RANGE: " + dist + " miles away. Maximum delivery distance is " + CONFIG.MAX_DELIVERY_MILES + " miles. Address: " + fmt);
            }
          }

          // Check if it has a street number (specific address, not just a city)
          var hasNum = place.address_components && place.address_components.some(function (c) { return c.types.indexOf("street_number") !== -1; });
          if (!hasNum) {
            // Found a general area but not specific — keep trying other variations
            if (v < variations.length - 1) continue;
            return res.json("PARTIAL: Found general area but not exact address: " + fmt + ". Ask for house or building number.");
          }

          return res.json("FOUND: " + fmt);
        }
      } catch (e) { console.log("Variation " + (v+1) + " error:", e.message); }
    }

    return res.json("NOT_FOUND: Could not find this address. Ask the customer to spell the street name and include the city.");
  } catch (e) {
    console.error("Address verify error:", e);
    return res.json("FOUND: Address accepted (verification unavailable). " + ((req.body.args && req.body.args.address) || ""));
  }
});

app.get("/debug", function (req, res) { res.json({ total: orderLog.length, orders: orderLog }); });

// ═══════════════════════════════════════════════════
// CLEAN ORDER VIEWER — easy to read receipts
// ═══════════════════════════════════════════════════
app.get("/orders", function (req, res) {
  var receipts = orderLog.map(function (o) {
    return {
      time: o.time,
      ref: o.ref,
      status: o.status,
      customer: o.customer_name || "?",
      phone: o.caller_phone_from_retell || "?",
      type: o.order_type || "?",
      payment: o.payment_method || "?",
      item_count: o.item_count || 0,
      items: o.item_summary || [],
      total: o.total || 0,
    };
  });
  res.json({ total: receipts.length, orders: receipts });
});

// Single order receipt by ref number
app.get("/order/:ref", function (req, res) {
  var ref = req.params.ref;
  var found = null;
  for (var i = 0; i < orderLog.length; i++) {
    if (String(orderLog[i].ref) === String(ref)) { found = orderLog[i]; break; }
  }
  if (!found) return res.json({ error: "Order " + ref + " not found in last 10 orders." });

  var receipt = "═══════════════════════════════════════\n";
  receipt += "  ORDER #" + found.ref + "\n";
  receipt += "  " + (found.time || "") + "\n";
  receipt += "═══════════════════════════════════════\n";
  receipt += "Customer: " + (found.customer_name || "?") + "\n";
  receipt += "Phone: " + (found.caller_phone_from_retell || "none") + "\n";
  receipt += "Type: " + (found.order_type || "?") + "\n";
  receipt += "Payment: " + (found.payment_method || "?") + "\n";
  receipt += "Status: " + (found.status || "?") + "\n";
  receipt += "───────────────────────────────────────\n";
  receipt += "ITEMS (" + (found.item_count || 0) + "):\n";

  var summary = found.item_summary || [];
  for (var j = 0; j < summary.length; j++) {
    var item = summary[j];
    receipt += "\n  " + item.qty + "x " + item.name + " $" + parseFloat(item.price).toFixed(2);
    receipt += " [ID:" + item.id + "]";
    if (item.is_combo) receipt += " (COMBO)";
    receipt += "\n";
    for (var m = 0; m < item.modifiers.length; m++) {
      receipt += "     → " + item.modifiers[m] + "\n";
    }
    for (var c = 0; c < item.components.length; c++) {
      var comp = item.components[c];
      receipt += "     ● " + comp.name + " [ID:" + comp.id + "]\n";
      for (var cm = 0; cm < comp.modifiers.length; cm++) {
        receipt += "       → " + comp.modifiers[cm] + "\n";
      }
    }
  }

  receipt += "───────────────────────────────────────\n";
  receipt += "Total: $" + parseFloat(found.total || 0).toFixed(2) + "\n";
  receipt += "═══════════════════════════════════════\n";

  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(receipt);
});

app.get("/test-order", async function (req, res) {
  var order = { order_type: "pickup", customer_name: "Test Regular", customer_phone: "8888888888",
    items: [{ item_name: '14" Large Cheese Pizza', item_id: "737", quantity: 1, unit_price: 11.99, modifiers: [{ group: "Add Toppings", name: "Pepperoni", price: 2.0 }] }],
    subtotal: 13.99, tax: 0.84, total: 14.83 };
  var built = buildXml(order);
  var result = await sendToPOS(built.xml);
  res.json({ version: "V15", xml: built.xml, pos: result, ref: built.ref });
});

app.get("/test-combo", async function (req, res) {
  var order = { order_type: "pickup", customer_name: "Test Combo", customer_phone: "8888888888",
    items: [{ item_name: '12"PIZZA W/1 TOP 8"SUB, 6 BUFFALO WING and 2 CAN OF SODA', item_id: "769", quantity: 1, unit_price: 29.99, is_combo: true,
      components: [
        { component_name: '12" Cheese Pizza', item_id: "736", modifiers: [{ group: "Add Toppings", name: "Pepperoni", price: 0 }] },
        { component_name: 'CHEESE STEAK SUB', item_id: "684", modifiers: [{ group: "Sub Fixins", name: "Everything", price: 0 }, { group: "Cheese Options", name: "American", price: 0 }] },
        { component_name: "6pcs Buffalo wings", item_id: "579", modifiers: [{ group: "Wings - Flavors", name: "Hot", price: 0 }, { group: "Wings - Dressing", name: "Ranch", price: 0 }] },
        { component_name: "Soda", item_id: "728", modifiers: [{ group: "Soda Can", name: "Coke", price: 0 }] },
        { component_name: "Soda", item_id: "728", modifiers: [{ group: "Soda Can", name: "Coke", price: 0 }] }
      ] }],
    subtotal: 29.99, tax: 1.80, total: 31.79 };
  var built = buildXml(order);
  var result = await sendToPOS(built.xml);
  res.json({ version: "V15", xml: built.xml, pos: result, ref: built.ref });
});

app.get("/test-delivery", async function (req, res) {
  var order = { order_type: "delivery", customer_name: "Test Delivery", customer_phone: "4105551234",
    delivery_address: "2755 Edmondson Ave, Baltimore, MD 21223",
    items: [{ item_name: '14" Large Cheese Pizza', item_id: "737", quantity: 1, unit_price: 11.99, modifiers: [{ group: "Add Toppings", name: "Pepperoni", price: 2.0 }] }],
    subtotal: 13.99, tax: 0.84, total: 16.78 };
  var built = buildXml(order);
  var result = await sendToPOS(built.xml);
  res.json({ version: "V15", xml: built.xml, pos: result, ref: built.ref });
});

app.get("/raw-xml", function (req, res) {
  var order = { order_type: "pickup", customer_name: "Raw Test", customer_phone: "8888888888",
    items: [{ item_name: 'Test Pizza', quantity: 1, unit_price: 11.99, modifiers: [{ group: "Add Toppings", name: "Pepperoni", price: 2.0 }] }],
    subtotal: 13.99, tax: 0.84, total: 14.83 };
  var built = buildXml(order);
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(built.xml);
});

app.get("/raw-lastorder", function (req, res) {
  res.set("Content-Type", "text/plain; charset=utf-8");
  if (orderLog.length > 0 && orderLog[0].xml) { res.send(orderLog[0].xml); } else { res.send("No orders yet"); }
});

app.get("/tag-test", function (req, res) {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send("NT variable resolves to: [" + NT + "]\nNTC variable resolves to: [" + NTC + "]\nSample: " + NT + "Pepperoni" + NTC);
});

// TEST ADDRESS: visit /test-address?q=123+Main+St+Chicago+IL
app.get("/test-address", async function (req, res) {
  var addr = req.query.q || req.query.address || "";
  if (!addr) return res.json({ error: "Add ?q=your+address to the URL. Example: /test-address?q=123+Main+St+Chicago+IL" });
  // Simulate what Retell sends
  var fakeReq = { body: { args: { address: addr } } };
  var fakeRes = { json: function (result) { res.json({ input: addr, result: result, has_api_key: !!CONFIG.GOOGLE_MAPS_API_KEY }); } };
  // Call the real verify function
  app.handle({ method: "POST", url: "/retell/function/verify_address", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: { address: addr } }) }, fakeRes);
});

// Simpler test-address that calls Google directly
app.get("/test-address2", async function (req, res) {
  var addr = req.query.q || "";
  if (!addr) return res.json({ error: "Add ?q=your+address. Example: /test-address2?q=123+Main+St+Chicago+IL" });
  if (!CONFIG.GOOGLE_MAPS_API_KEY) return res.json({ error: "No GOOGLE_MAPS_API_KEY set in environment" });
  try {
    var r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(addr) + "&key=" + CONFIG.GOOGLE_MAPS_API_KEY);
    var geo = await r.json();
    res.json({ input: addr, status: geo.status, results_count: geo.results ? geo.results.length : 0, results: geo.results || [], error_message: geo.error_message || null });
  } catch (e) { res.json({ error: e.message }); }
});

app.get("/", function (req, res) {
  res.json({ status: "running", version: "V16", restaurant_id: CONFIG.RESTAURANT_ID,
    has_payment: !!process.env.USAEPAY_KEY,
    endpoints: ["POST /retell/function/submit_order", "POST /retell/function/verify_address", "POST /retell/function/process_payment", "POST /retell/function/get_caller_id",
      "POST /retell/function/calculate_price", "POST /retell/function/calculate_combo",
      "GET /orders (clean receipt list)", "GET /order/:ref (single receipt)", "GET /payment-log",
      "GET /test-order", "GET /test-combo", "GET /test-delivery", "GET /test-payment", "GET /debug"] });
});

// ═══════════════════════════════════════════════════
// PRICING ENGINE — complete menu database + calculation tools
// Agent calls these tools instead of doing math
// ═══════════════════════════════════════════════════

// Pizza topping prices by size, and modifier IDs
var TOPPING_PRICES = {
  10: {full:1.00, half:0.50, shrimp:1.50, anchovy:1.50, shrimp_half:1.00, anchovy_half:1.00},
  12: {full:1.50, half:0.75, shrimp:2.00, anchovy:2.00, shrimp_half:1.00, anchovy_half:1.00},
  14: {full:2.00, half:1.00, shrimp:2.00, anchovy:2.00, shrimp_half:1.25, anchovy_half:1.25},
  16: {full:2.50, half:1.25, shrimp:3.50, anchovy:3.50, shrimp_half:1.75, anchovy_half:1.75},
  18: {full:3.00, half:1.50, shrimp:4.00, anchovy:4.00, shrimp_half:2.00, anchovy_half:2.00}
};

// Topping modifier IDs by size (full)
var TOPPING_IDS = {
  10: {ground_beef:749,ham:750,sausage:751,pepperoni:752,black_olives:753,jalapenos:754,green_peppers:755,mushrooms:756,onions:757,chicken:758,pineapple:759,sweet_peppers:760,banana_peppers:761,broccoli:762,spinach:763,bacon:764,extra_cheese:765,tomatoes:766,shrimp:854,anchovy:855,welldone:767,lite_sauce:768,extra_sauce:769},
  12: {ground_beef:940,ham:941,sausage:942,pepperoni:943,black_olives:944,jalapenos:945,green_peppers:946,mushrooms:947,onions:948,chicken:949,pineapple:950,sweet_peppers:951,banana_peppers:952,broccoli:953,spinach:954,bacon:955,extra_cheese:956,tomatoes:957,shrimp:961,anchovy:962,welldone:958,lite_sauce:959,extra_sauce:960},
  14: {ground_beef:963,ham:964,sausage:965,pepperoni:966,black_olives:967,jalapenos:968,green_peppers:969,mushrooms:970,onions:971,chicken:972,pineapple:973,sweet_peppers:974,banana_peppers:975,broccoli:976,spinach:977,bacon:978,extra_cheese:979,tomatoes:980,shrimp:984,anchovy:985,welldone:981,lite_sauce:982,extra_sauce:983},
  16: {ground_beef:986,ham:987,sausage:988,pepperoni:989,black_olives:990,jalapenos:991,green_peppers:992,mushrooms:993,onions:994,chicken:995,pineapple:996,sweet_peppers:997,banana_peppers:998,broccoli:999,spinach:1000,bacon:1001,extra_cheese:1002,tomatoes:1003,shrimp:1007,anchovy:1008,welldone:1004,lite_sauce:1005,extra_sauce:1006},
  18: {ground_beef:1009,ham:1010,sausage:1011,pepperoni:1012,black_olives:1013,jalapenos:1014,green_peppers:1015,mushrooms:1016,onions:1017,chicken:1018,pineapple:1019,sweet_peppers:1020,banana_peppers:1021,broccoli:1022,spinach:1023,bacon:1024,extra_cheese:1025,tomatoes:1026,shrimp:1030,anchovy:1031,welldone:1027,lite_sauce:1028,extra_sauce:1029}
};

var FREE_TOPPINGS = ["welldone","lite_sauce","extra_sauce","lite_cheese","no_sauce"];

function round2(n) { return Math.round(n * 100) / 100; }

function normTopping(name) {
  return (name||"").toLowerCase().replace(/[^a-z]/g,"_").replace(/_+/g,"_").replace(/^_|_$/g,"");
}

// Alias map: common agent spellings → DB key
var TOPPING_ALIASES = {
  "jalapeno": "jalapenos", "jalape_o": "jalapenos", "jalapeño": "jalapenos", "jalapeños": "jalapenos",
  "onion": "onions", "mushroom": "mushrooms", "olive": "black_olives",
  "black_olive": "black_olives", "green_pepper": "green_peppers",
  "sweet_pepper": "sweet_peppers", "banana_pepper": "banana_peppers",
  "latino_pepper": "banana_peppers", "latino_peppers": "banana_peppers", "latino": "banana_peppers",
  "tomato": "tomatoes", "anchovi": "anchovy",
  "pepper": "green_peppers", "pineapples": "pineapple"
};

// Universal modifier aliases — covers all modifier types
var MODIFIER_ALIASES = {
  // Sub fixins — common speech variants
  "tomato": "tomatoes", "onion": "onions", "hot pepper": "hot_peppers",
  "hot_pepper": "hot_peppers", "hots": "hot_peppers", "hot": "hot_peppers",
  "raw_onion": "raw_onions", "grilled_onion": "grilled_onions",
  "pickle": "pickles", "salt_pepper": "salt_n_pepper", "salt pepper": "salt_n_pepper",
  "salt and pepper": "salt_n_pepper", "s_p": "salt_n_pepper", "s_and_p": "salt_n_pepper",
  "no hots": "everything_no_hots", "everything no hots": "everything_no_hots",
  "no hot peppers": "everything_no_hots", "no_hot_peppers": "everything_no_hots",
  "mayonnaise": "mayo", "mayonaise": "mayo", "mayonese": "mayo", "may": "mayo",
  "ketchup": "ketchup", "catsup": "ketchup",
  "lettice": "lettuce", "letuce": "lettuce",
  "mustard": "mustard",
  "extra_meat": "extra_meat", "extra meat": "extra_meat", "double meat": "extra_meat",
  "extra_cheese": "extra_cheese", "extra cheese": "extra_cheese",
  "fried_onions": "fried_onions", "fried onion": "fried_onions", "fried_onion": "fried_onions",
  "grilled_onions": "grilled_onions", "grilled onion": "grilled_onions",
  "raw_onions": "raw_onions", "raw onion": "raw_onions",
  "banana_pepper": "banana_peppers", "banana pepper": "banana_peppers", "banana": "banana_peppers",
  "latino_pepper": "banana_peppers", "latino_peppers": "banana_peppers", "latino": "banana_peppers",
  "sweet_pepper": "sweet_peppers", "sweet pepper": "sweet_peppers",
  "green_pepper": "green_peppers", "green pepper": "green_peppers",
  "jalapeño": "jalapeno", "jalapeños": "jalapeno", "jalapeno": "jalapeno",
  "black_olive": "black_olives", "black olive": "black_olives", "olive": "black_olives", "olives": "black_olives",
  "mushroom": "mushrooms", "shroom": "mushrooms", "shrooms": "mushrooms",
  "pepperoni": "pepperoni", "peperoni": "pepperoni", "pepperonie": "pepperoni",
  "sausage": "sausage",
  // Cheese
  "feta": "feta_cheese", "no cheese": "no_cheese", "extra cheese": "extra_cheese",
  "provolone cheese": "provolone", "american cheese": "american", "mozz": "mozzarella",
  "mozzarela": "mozzarella", "mozzerella": "mozzarella", "mozerella": "mozzarella",
  "prov": "provolone", "provo": "provolone",
  // Wing flavors
  "general tso": "general_tso_s", "general tsos": "general_tso_s",
  "no sauce": "no_flavor", "plain": "no_flavor", "no flavor": "no_flavor",
  "lemon_pepper": "lemon_pepper", "lemon pepper": "lemon_pepper",
  "honey_bbq": "honey_bbq", "honey barbecue": "honey_bbq", "honey barbeque": "honey_bbq",
  "honey_lemon_pepper": "honey_lemon_pepper", "honey lemon pepper": "honey_lemon_pepper",
  "honey_old_bay": "honey_old_bay", "honey old bay": "honey_old_bay",
  "old_bay": "old_bay", "old bay": "old_bay",
  "honey_mustard": "honey_mustard", "honey mustard": "honey_mustard",
  "honey_garlic": "honey_garlic", "honey garlic": "honey_garlic",
  "garlic_parmesan": "garlic_parmesan", "garlic parmesan": "garlic_parmesan", "garlic parm": "garlic_parmesan",
  "mango_habanero": "mango_habanero", "mango habanero": "mango_habanero", "mango": "mango_habanero",
  "caribbean_jerk": "caribbean_jerk", "caribbean jerk": "caribbean_jerk",
  "jamaican_jerk": "jamaican_jerk", "jamaican jerk": "jamaican_jerk", "jerk": "jamaican_jerk",
  "maryland_style": "maryland_style", "maryland style": "maryland_style", "maryland": "maryland_style",
  "thai_chili": "thai_chili", "thai chili": "thai_chili", "thai": "thai_chili",
  "toxic_waste": "toxic_waste", "toxic waste": "toxic_waste", "toxic": "toxic_waste",
  "southern_style": "southern_style", "southern style": "southern_style", "southern": "southern_style",
  "spicy_bbq": "spicy_bbq", "spicy bbq": "spicy_bbq", "spicy barbecue": "spicy_bbq",
  "spicy_honey_bbq": "spicy_honey_bbq", "spicy honey bbq": "spicy_honey_bbq",
  "extra_hot": "extra_hot", "extra hot": "extra_hot",
  "roasted_garlic": "roasted_garlic", "roasted garlic": "roasted_garlic",
  "bourbon": "bourbon",
  // Wing dressings
  "bleu cheese": "blue_cheese", "bleu_cheese": "blue_cheese",
  "ranch dressing": "ranch", "blue cheese dressing": "blue_cheese",
  "extra_dressing": "extra_dressing", "extra dressing": "extra_dressing",
  "hot_sauce": "hot_sauce", "hot sauce": "hot_sauce",
  // Soda
  "diet coke": "diet_coke", "diet pepsi": "diet_pepsi", "cherry coke": "cherry_coke",
  "cherry pepsi": "cherry_pepsi", "coke zero": "coke_zero", "mountain dew": "mountain_dew",
  "dr pepper": "dr_pepper", "dr_pepper": "dr_pepper", "dr. pepper": "dr_pepper",
  "root beer": "root_beer", "ginger ale": "ginger_ale", "sierra mist": "sierra_mist",
  "fanta orange": "fanta_orange", "fanta grape": "fanta_grape",
  "fanta strawberry": "fanta_strawberry", "fanta pineapple": "fanta_pineapple",
  "crush grape": "crush_grape", "fruit punch": "fruit_punch",
  "half and half": "half_and_half", "half n half": "half_and_half",
  "starry": "starry_lemon_lime", "starry lemon lime": "starry_lemon_lime",
  "mt dew": "mountain_dew", "mt. dew": "mountain_dew", "dew": "mountain_dew",
  // Salad dressing
  "creamy italian": "creamy_italian", "italian dressing": "creamy_italian", "italian": "creamy_italian",
  "thousand island": "thousand_island", "thousand": "thousand_island",
  "balsamic vinaigrette": "balsamic_vinaigrette", "balsamic": "balsamic_vinaigrette",
  "caesar dressing": "caesar",
  "french dressing": "french",
  // Tender sauce
  "blue cheese": "blue_cheese",
  // Gyro meat
  "chicken gyro": "chicken", "lamb gyro": "lamb",
  // Sandwich fixins
  "fried onion": "fried_onions", "fried_onion": "fried_onions",
  "banana_pepper": "banana_peppers",
  "sweet_pepper": "sweet_peppers",
  "green_pepper": "green_peppers",
  "black_olive": "black_olives",
  "mushroom": "mushrooms",
  "salt_n_pepper": "salt_n_pepper", "salt n pepper": "salt_n_pepper",
  // Wrap/Gyro fixins
  "tzatziki": "tzatziki_sauce", "tzatziki sauce": "tzatziki_sauce", "tzatziki_sauce": "tzatziki_sauce",
  "feta_cheese": "feta_cheese", "feta cheese": "feta_cheese",
  // Underscore versions (normTopping converts spaces to underscores)
  "salt_and_pepper": "salt_n_pepper", "double_meat": "extra_meat",
  "provolone_cheese": "provolone", "american_cheese": "american",
  "general_tsos": "general_tso_s", "no_sauce": "no_flavor",
  "honey_barbecue": "honey_bbq", "honey_barbeque": "honey_bbq",
  "spicy_barbecue": "spicy_bbq",
  "ranch_dressing": "ranch", "blue_cheese_dressing": "blue_cheese",
  "mt_dew": "mountain_dew", "half_n_half": "half_and_half",
  "italian_dressing": "creamy_italian", "caesar_dressing": "caesar",
  "french_dressing": "french", "chicken_gyro": "chicken", "lamb_gyro": "lamb",
  "grilled_onion": "grilled_onions", "raw_onion": "raw_onions",
  "garlic_parm": "garlic_parmesan", "no_hot_peppers": "everything_no_hots",
  "tartar": "tartar_sauce", "tartar_sauce": "tartar_sauce", "tarter": "tartar_sauce",
  "tarter_sauce": "tartar_sauce", "tar_tar": "tartar_sauce",
  "oil_and_vinegar": "oil_and_vinegar", "oil_vinegar": "oil_and_vinegar",
  "oil and vinegar": "oil_and_vinegar", "oil vinegar": "oil_and_vinegar",
  "banana_peppers": "banana_peppers", "banana_pepper": "banana_peppers",
  "green_peppers": "green_peppers", "green_pepper": "green_peppers",
  "black_olives": "black_olives", "black_olive": "black_olives",
  "olive": "black_olives", "olives": "black_olives"
};

// Universal fuzzy resolve for key-based lookups (SUB_FIXINS_IDS, CHEESE_IDS, etc.)
function resolveModifier(input, map) {
  var n = normTopping(input);
  // 1. Exact match
  if (map[n] !== undefined) return n;
  // 2. Modifier alias
  if (MODIFIER_ALIASES[n] && map[MODIFIER_ALIASES[n]] !== undefined) return MODIFIER_ALIASES[n];
  // 3. Topping alias (reuse)
  if (TOPPING_ALIASES[n] && map[TOPPING_ALIASES[n]] !== undefined) return TOPPING_ALIASES[n];
  // 4. Try with 's'
  if (map[n + "s"] !== undefined) return n + "s";
  // 5. Try without 's'
  if (n.endsWith("s") && map[n.slice(0,-1)] !== undefined) return n.slice(0,-1);
  // 6. Try without 'es'
  if (n.endsWith("es") && map[n.slice(0,-2)] !== undefined) return n.slice(0,-2);
  // 7. Try raw lowercase input (for exact DB name matches like "Diet Coke")
  var raw = (input||"").toLowerCase().trim();
  if (map[raw] !== undefined) return raw;
  return null;
}

// Universal fuzzy match for DB array lookups (.find on array of objects)
// nameField = which property to match against (e.g., "flavor_name", "fixin_name", "dressing_name")
function fuzzyFindInArray(input, arr, nameField) {
  if (!arr || !arr.length) return null;
  var raw = (input||"").toLowerCase().trim();
  var norm = normTopping(input);
  
  // 1. Exact name match (case-insensitive)
  for (var i = 0; i < arr.length; i++) {
    if ((arr[i][nameField]||"").toLowerCase().trim() === raw) return arr[i];
  }
  // 2. Normalized match
  for (var i = 0; i < arr.length; i++) {
    if (normTopping(arr[i][nameField]) === norm) return arr[i];
  }
  // 3. Alias match
  var aliasNorm = MODIFIER_ALIASES[norm] || TOPPING_ALIASES[norm] || null;
  if (aliasNorm) {
    for (var i = 0; i < arr.length; i++) {
      if (normTopping(arr[i][nameField]) === aliasNorm) return arr[i];
    }
  }
  // 4. Add/remove 's'
  var variants = [norm + "s"];
  if (norm.endsWith("s")) variants.push(norm.slice(0,-1));
  if (norm.endsWith("es")) variants.push(norm.slice(0,-2));
  for (var v = 0; v < variants.length; v++) {
    for (var i = 0; i < arr.length; i++) {
      if (normTopping(arr[i][nameField]) === variants[v]) return arr[i];
    }
  }
  // 5. Partial contains (last resort)
  for (var i = 0; i < arr.length; i++) {
    var dbNorm = normTopping(arr[i][nameField]);
    if (dbNorm.indexOf(norm) !== -1 || norm.indexOf(dbNorm) !== -1) return arr[i];
  }
  return null;
}

function resolveTopping(norm, sp) {
  // Try exact match first
  if (sp[norm] !== undefined) return norm;
  // Try alias
  if (TOPPING_ALIASES[norm] && sp[TOPPING_ALIASES[norm]] !== undefined) return TOPPING_ALIASES[norm];
  // Try adding 's'
  if (sp[norm + "s"] !== undefined) return norm + "s";
  // Try removing trailing 's'
  if (norm.endsWith("s") && sp[norm.slice(0,-1)] !== undefined) return norm.slice(0,-1);
  // Try removing trailing 'es'
  if (norm.endsWith("es") && sp[norm.slice(0,-2)] !== undefined) return norm.slice(0,-2);
  // Partial match: find key where first 5+ chars match (handles jalape_os vs jalapenos)
  if (norm.length >= 5) {
    var prefix = norm.substring(0, 5);
    var keys = Object.keys(sp);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].substring(0, 5) === prefix) return keys[i];
    }
  }
  return null;
}

function getToppingPrice(name, size, isHalf) {
  var n = normTopping(name);
  if (FREE_TOPPINGS.indexOf(n) !== -1) return 0;
  // Also check aliases for free toppings
  var alias = TOPPING_ALIASES[n];
  if (alias && FREE_TOPPINGS.indexOf(alias) !== -1) return 0;
  
  var sp = TOPPING_PRICES[size];
  if (!sp) return 0;
  
  // Resolve the key (handles singular/plural/aliases)
  var key = resolveTopping(n, sp);
  
  // DB format: sp[topping_name] = {full, half}
  if (key && sp[key] && typeof sp[key] === "object") return isHalf ? (sp[key].half || 0) : (sp[key].full || 0);
  
  // Hardcoded format: sp = {full, half, shrimp, shrimp_half, ...}
  if (n === "shrimp" || alias === "shrimp") return isHalf ? (sp.shrimp_half || sp.half || 0) : (sp.shrimp || sp.full || 0);
  if (n === "anchovy" || n === "anchovi" || alias === "anchovy") return isHalf ? (sp.anchovy_half || sp.half || 0) : (sp.anchovy || sp.full || 0);
  return isHalf ? (sp.half || 0) : (sp.full || 0);
}

function getToppingId(name, size) {
  var n = normTopping(name);
  var ids = TOPPING_IDS[size];
  if (!ids) return null;
  // Try exact, then resolve
  if (ids[n]) return ids[n];
  var key = resolveTopping(n, ids);
  if (key && ids[key]) return ids[key];
  return null;
}

// Complete sub database
var SUBS_DB = [
  // Grilled
  {keys:["cheese steak","cheesesteak","cs sub"], id:684, name:"Cheese Steak Sub", p8:8.49, p12:12.49},
  {keys:["chicken cheese steak","chicken cheesesteak","chicken cs"], id:685, name:"Chicken Cheese Steak Sub", p8:8.49, p12:12.49},
  {keys:["cheese burger sub","cheeseburger sub"], id:686, name:"Cheese Burger Sub", p8:8.49, p12:12.49},
  {keys:["steak sub"], id:687, name:"Steak Sub", p8:8.49, p12:12.49},
  {keys:["hamburger sub","hamburger"], id:688, name:"Hamburger Sub", p8:7.99, p12:11.99},
  {keys:["meat ball","meatball","meatball sub"], id:689, name:"Meat Ball Sub", p8:7.99, p12:11.99},
  {keys:["turkey burger sub","turkey burger"], id:690, name:"Turkey Burger Sub", p8:7.99, p12:11.99},
  {keys:["chicken parmesan","chicken parm sub","chicken parm"], id:691, name:"Chicken Parmesan Sub", p8:8.49, p12:12.49},
  {keys:["grilled chicken sub","chicken sub"], id:692, name:"Grilled Chicken Sub", p8:8.49, p12:12.49},
  {keys:["chicken fillet","chicken fillet sub"], id:693, name:"Chicken Fillet Sub", p8:8.49, p12:12.49},
  {keys:["pizza sub"], id:694, name:"Pizza Sub", p8:7.99, p12:11.99},
  {keys:["chilli sub","chili sub","chili"], id:695, name:"Chilli Sub", p8:7.99, p12:11.99},
  {keys:["cheese fish sub","fish sub"], id:801, name:"Cheese Fish Sub", p8:8.49, p12:12.49},
  {keys:["crab cake sub","crab sub"], id:833, name:"Crab Cake Sub", p8:9.49, p12:13.49},
  // Cold cuts
  {keys:["italian cold cut","italian cold"], id:702, name:"Italian Cold Cut Sub", p8:7.99, p12:11.99},
  {keys:["italian hot cut","italian hot"], id:703, name:"Italian Hot Cut Sub", p8:7.99, p12:11.99},
  {keys:["turkey breast sub","turkey sub","turkey breast"], id:704, name:"Turkey Breast Sub", p8:7.99, p12:11.99},
  {keys:["ham and cheese","ham cheese sub","ham sub"], id:705, name:"Ham and Cheese Sub", p8:7.99, p12:11.99},
  {keys:["tuna salad sub","tuna sub","tuna"], id:706, name:"Tuna Salad Sub", p8:7.99, p12:11.99},
  {keys:["chicago cold cut","chicago cold","chicago sub"], id:707, name:"Chicago Cold Cut Sub", p8:8.49, p12:12.49},
  {keys:["chicken salad sub","chicken salad"], id:708, name:"Chicken Salad Sub", p8:7.99, p12:11.99},
  {keys:["chipotle sub","chipotle"], id:709, name:"Chipotle Sub", p8:8.49, p12:12.49},
  {keys:["shrimp salad sub","shrimp salad"], id:710, name:"Shrimp Salad Sub", p8:8.99, p12:12.99},
  {keys:["regular cold cut","american cold cut","regular cold"], id:825, name:"Regular Cold Cut Sub", p8:7.49, p12:10.99},
  {keys:["regular hot cut","american hot cut","regular hot"], id:826, name:"Regular Hot Cut Sub", p8:7.49, p12:10.99},
  // Special — MUST be before cheese steak to match "philly cheese steak" before "cheese steak"
  {keys:["shrimp cheese steak","shrimp cheesesteak","shrimp cs"], id:726, name:"Shrimp Cheese Steak Sub", p8:9.99, p12:14.49},
  {keys:["philly cheese steak sub","philly cheesesteak sub","philly cs sub","philly cheese steak","philly cheesesteak","philly cs","philly sub"], id:723, name:"Philly Cheese Steak Sub", p8:9.49, p12:13.99},
  {keys:["philly chicken","philly chicken sub"], id:724, name:"Philly Chicken Sub", p8:9.49, p12:13.99},
  {keys:["cheese steak special","cheesesteak special","cs special"], id:725, name:"Cheese Steak Special Sub", p8:9.49, p12:13.49},
  {keys:["veggie sub","veggie"], id:727, name:"Veggie Sub", p8:8.49, p12:12.49},
];

// Sub fixins modifier IDs
var SUB_FIXINS_IDS = {everything:463,lettuce:464,tomatoes:465,mayo:466,mustard:467,ketchup:468,onions:469,hot_peppers:470,raw_onions:746,grilled_onions:747,fried_onions:695,everything_no_hots:1302,pickles:1304,salt_n_pepper:1305,extra_meat:471,bacon:472,extra_cheese:473,shrimp:748,ham:744,turkey:745,banana_peppers:1306,green_peppers:1307,black_olives:1308,mushrooms:1309,oil_and_vinegar:1310,tartar_sauce:1311};
var SUB_FIXINS_PRICES = {extra_meat:1.00,bacon:1.00,extra_cheese:1.00,shrimp:1.00};
var CHEESE_IDS = {american:488,provolone:489,mozzarella:492,feta_cheese:493,feta:493,no_cheese:491,extra_cheese:490};
var CHEESE_PRICES = {extra_cheese:1.00};

// Combo deals database
var COMBO_DB = {
  "double deal": {sizes:{12:{id:786,price:19.99},14:{id:787,price:21.99},16:{id:788,price:24.99}}, desc:"2 same-size cheese pizzas (1 top each)", pizzas:2, freeToppings:1},
  "3 pizza special": {sizes:{14:{id:777,price:36.99},16:{id:778,price:38.99}}, desc:"3 same-size cheese pizzas (1 top each) + 2L soda", pizzas:3, freeToppings:1, includes_2l:true},
  "three pizza special": {sizes:{14:{id:777,price:36.99},16:{id:778,price:38.99}}, desc:"3 same-size cheese pizzas (1 top each) + 2L soda", pizzas:3, freeToppings:1, includes_2l:true},
  "pizza and wings": {sizes:{12:{id:781,price:25.99},14:{id:782,price:26.99},16:{id:783,price:27.99}}, desc:"pizza (1 top) + 10 buffalo wings + 2L soda", pizzas:1, freeToppings:1, includes_2l:true, wings:10},
  "family deal": {sizes:{12:{id:781,price:25.99},14:{id:782,price:26.99},16:{id:783,price:27.99}}, desc:"pizza (1 top) + 10 buffalo wings + 2L soda", pizzas:1, freeToppings:1, includes_2l:true, wings:10},
  "pizza and sub": {sizes:{12:{id:784,price:22.99},14:{id:794,price:24.99},16:{id:744,price:26.99}}, desc:"pizza (1 top) + 8\" sub + fries + can soda", pizzas:1, freeToppings:1, includes_fries:true, includes_can:true},
  "pizza sub combo": {sizes:{12:{id:784,price:22.99},14:{id:794,price:24.99},16:{id:744,price:26.99}}, desc:"pizza (1 top) + 8\" sub + fries + can soda", pizzas:1, freeToppings:1, includes_fries:true, includes_can:true},
  "combo deal": {sizes:{12:{id:769,price:29.99},14:{id:770,price:33.99}}, desc:"pizza (1 top) + 8\" sub + wings + 2 cans", pizzas:1, freeToppings:1},
  "sub combo": {sizes:{8:{id:772,price:11.99},12:{id:774,price:15.99}}, desc:"sub + fries + can soda", pizzas:0, includes_fries:true, includes_can:true},
  "2 sub combo": {sizes:{0:{id:773,price:21.99}}, desc:"2 subs + 2 fries + 2 cans", pizzas:0},
  "two sub combo": {sizes:{0:{id:773,price:21.99}}, desc:"2 subs + 2 fries + 2 cans", pizzas:0},
  "3 sub combo": {sizes:{0:{id:780,price:31.99}}, desc:"3 subs + 3 fries + 3 cans", pizzas:0},
  "three sub combo": {sizes:{0:{id:780,price:31.99}}, desc:"3 subs + 3 fries + 3 cans", pizzas:0},
  "wings and sub": {sizes:{0:{id:771,price:17.99}}, desc:"8\" sub + 6 buffalo wings + can soda", pizzas:0},
  "wings special buffalo": {sizes:{0:{id:840,price:9.49}}, desc:"6 buffalo wings + fries + can soda", pizzas:0},
  "wings special whole": {sizes:{0:{id:839,price:10.49}}, desc:"4 whole wings + fries + can soda", pizzas:0},
  "chicken box whole": {sizes:{0:{id:838,price:20.99}}, desc:"2x 4pc whole wings + 2 cans", pizzas:0},
  "chicken box buffalo": {sizes:{0:{id:847,price:25.99}}, desc:"2x 6pc buffalo wings + 2 cans", pizzas:0},
  "burger combo": {sizes:{0:{id:793,price:7.99}}, desc:"cheeseburger sandwich + fries + can soda", pizzas:0, includes_fries:true, includes_can:true},
  "fish combo": {sizes:{0:{id:831,price:8.99}}, desc:"cheese fish sandwich + fries + can soda", pizzas:0, includes_fries:true, includes_can:true},
  "party deal": {sizes:{0:{id:776,price:84.99}}, desc:"4 large cheese pizzas + 48 wings + fries + 2L", pizzas:4, freeToppings:1},
};

function matchSub(input) {
  var nm = (input||"").toLowerCase().replace(/[^a-z ]/g,"").trim();
  // Sort by key length descending so "shrimp cheese steak" matches before "cheese steak"
  var sorted = SUBS_DB.slice().sort(function(a,b) {
    var aMax = Math.max.apply(null, a.keys.map(function(k){return k.length;}));
    var bMax = Math.max.apply(null, b.keys.map(function(k){return k.length;}));
    return bMax - aMax;
  });
  for (var i = 0; i < sorted.length; i++) {
    for (var k = 0; k < sorted[i].keys.length; k++) {
      if (nm.indexOf(sorted[i].keys[k]) !== -1) return sorted[i];
    }
  }
  return null;
}

function buildModifiers(toppings, size, freeToppingsCount) {
  var mods = [];
  var chargeableSoFar = 0;
  var totalExtra = 0;
  
  for (var t = 0; t < toppings.length; t++) {
    var top = toppings[t];
    var topName = (top.name || top || "").trim();
    var isHalf = !!(top.half || (topName.toLowerCase().indexOf("half") !== -1));
    var cleanName = topName.replace(/\s*\(half\)\s*/gi,"").replace(/^half\s+/i,"").trim();
    var norm = normTopping(cleanName);
    
    // Skip free toppings (check aliases too)
    var normAlias = TOPPING_ALIASES[norm] || norm;
    if (FREE_TOPPINGS.indexOf(norm) !== -1 || FREE_TOPPINGS.indexOf(normAlias) !== -1) {
      mods.push({name: cleanName, modifier_id: getToppingId(cleanName, size), group: "Add Toppings", price: 0, charge: 0});
      continue;
    }
    
    chargeableSoFar++;
    var isFree = chargeableSoFar <= freeToppingsCount;
    var price = isFree ? 0 : getToppingPrice(cleanName, size, isHalf);
    totalExtra += price;
    
    var displayName = cleanName;
    if (isHalf) displayName = cleanName + " (Half)";
    
    mods.push({
      name: displayName,
      modifier_id: getToppingId(cleanName, size),
      group: "Add Toppings",
      price: price,
      charge: price
    });
  }
  return {modifiers: mods, extra_charge: totalExtra};
}

// Generic menu item search — matches by keywords, longest match first
function findMenuItem(input) {
  var nm = (input || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (!nm) return null;
  
  var items = MENU_CACHE.items.length > 0 ? MENU_CACHE.items : [];
  var best = null;
  var bestLen = 0;
  
  for (var i = 0; i < items.length; i++) {
    var kws = items[i].keywords || [];
    for (var k = 0; k < kws.length; k++) {
      if (nm.indexOf(kws[k]) !== -1 && kws[k].length > bestLen) {
        best = items[i];
        bestLen = kws[k].length;
      }
    }
    // Also match item_name directly
    if (nm.indexOf(items[i].item_name.toLowerCase()) !== -1 && items[i].item_name.length > bestLen) {
      best = items[i];
      bestLen = items[i].item_name.length;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════
// TOOL 1: calculate_price — for ALL menu items
// ═══════════════════════════════════════════════════
app.post("/retell/function/calculate_price", function (req, res) {
  try {
    var args = req.body.args || req.body;
    var itemType = (args.item_type || "").toLowerCase().trim();
    var size = parseInt(args.size || 0);
    var toppings = args.toppings || [];
    var subName = (args.sub_name || args.item_name || "").trim();
    var subSize = (args.sub_size || "half").toLowerCase();
    var fixins = args.fixins || [];
    var cheese = (args.cheese || "").trim();
    var specialInstructions = (args.special_instructions || "").trim();
    // Additional params for all item types
    args.wing_flavor = args.wing_flavor || "";
    args.wing_dressing = args.wing_dressing || "";
    args.salad_dressing = args.salad_dressing || "";
    args.gyro_meat = args.gyro_meat || "";
    args.tender_sauce = args.tender_sauce || "";
    args.soda_flavor = args.soda_flavor || "";
    args.quantity = args.quantity || 0;

    // ── PIZZA ──
    if (itemType === "pizza" || itemType === "cheese pizza" || itemType === "specialty pizza") {
      if (!size || !TOPPING_PRICES[size]) {
        return res.json("ERROR: Invalid pizza size. Must be 10, 12, 14, 16, or 18.");
      }
      var pizzaIds = {10:735, 12:736, 14:737, 16:738, 18:739};
      var pizzaPrices = {10:8.99, 12:10.99, 14:11.99, 16:13.99, 18:14.99};
      var sizeLabels = {10:"Sm",12:"Med",14:"Lrg",16:"XL",18:"XXL"};
      
      // Check for specialty pizza
      var pizzaName = (args.pizza_name || args.item_name || "").toLowerCase();
      var isSpecialty = false;
      if (pizzaName && itemType === "specialty pizza") {
        var specMatch = findMenuItem(pizzaName);
        if (specMatch && specMatch.item_type === "specialty_pizza") {
          var specPrice = parseFloat(specMatch["price_" + size] || 0);
          if (specPrice > 0) {
            return res.json({
              item_name: size + " inch " + sizeLabels[size] + " " + specMatch.item_name,
              item_id: specMatch.pos_id,
              category: "Pizzas",
              base_price: specPrice,
              unit_price: specPrice,
              modifiers: [],
              note: "Specialty pizzas do not qualify for combo deals.",
              special_instructions: specialInstructions || undefined
            });
          }
        }
        return res.json("ERROR: Specialty pizza not found. Available: Deluxe, Supreme, Veggie, Hawaiian, Steak, Philly CS, NY Style, Buffalo Chicken, BBQ Chicken, Chicken Bacon Ranch, Meat Lover, Meal Buster, Unique.");
      }
      
      // Cheese pizza — use DB prices if available
      var cheesePizzaDB = MENU_CACHE.items.find(function(i) { return i.item_type === "cheese_pizza"; });
      var basePrice = cheesePizzaDB ? parseFloat(cheesePizzaDB["price_" + size] || pizzaPrices[size]) : pizzaPrices[size];
      var result = buildModifiers(toppings, size, 0); // 0 free toppings for regular pizza
      var unitPrice = round2(basePrice + result.extra_charge);
      
      return res.json({
        item_name: size + " inch " + sizeLabels[size] + " Cheese Pizza",
        item_id: pizzaIds[size],
        category: "Pizzas",
        base_price: basePrice,
        topping_charges: result.extra_charge,
        unit_price: unitPrice,
        modifiers: result.modifiers,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── SUB ──
    if (itemType === "sub" || itemType === "submarine") {
      var sub = matchSub(subName);
      if (!sub) return res.json("ERROR: Sub not found. Available subs: cheese steak, chicken cheese steak, philly cheese steak, shrimp cheese steak, italian cold cut, turkey breast, ham and cheese, tuna, meatball, grilled chicken, pizza sub, veggie, and more.");
      
      var is12 = (subSize === "whole" || subSize === "12" || subSize === "12 inch");
      var subPrice = is12 ? sub.p12 : sub.p8;
      var sizePrefix = is12 ? "12 inch Whole " : "8 inch Half ";
      
      // Build fixins modifiers
      var fixinMods = [];
      var fixinExtra = 0;
      for (var f = 0; f < fixins.length; f++) {
        var fn = normTopping(fixins[f]);
        var fkey = resolveModifier(fixins[f], SUB_FIXINS_IDS);
        var fid = fkey ? SUB_FIXINS_IDS[fkey] : null;
        var fprice = fkey ? (SUB_FIXINS_PRICES[fkey] || 0) : 0;
        fixinExtra += fprice;
        fixinMods.push({name: fixins[f], modifier_id: fid, group: "Sub Fixins", price: fprice});
      }
      
      // Cheese modifier
      var cheeseMod = null;
      if (cheese) {
        var ckey = resolveModifier(cheese, CHEESE_IDS);
        var cid = ckey ? CHEESE_IDS[ckey] : null;
        var cprice = ckey ? (CHEESE_PRICES[ckey] || 0) : 0;
        fixinExtra += cprice;
        cheeseMod = {name: cheese, modifier_id: cid, group: "Cheese Options", price: cprice};
      }
      
      var allMods = fixinMods;
      if (cheeseMod) allMods.push(cheeseMod);
      
      return res.json({
        item_name: sizePrefix + sub.name,
        item_id: sub.id,
        category: "Submarines",
        base_price: subPrice,
        extra_charges: fixinExtra,
        unit_price: round2(subPrice + fixinExtra),
        modifiers: allMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── SANDWICH ──
    if (itemType === "sandwich") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Sandwich not found. Say the full name like: cheeseburger, cheese fish, grilled chicken, crispy chicken, fried fish, BLT, hot dog, crab cake.");
      
      var sandMods = [];
      var sandExtra = 0;
      // Sandwich fixins from DB or hardcoded
      var sandFixinsDB = MENU_CACHE.sandwich_fixins.length > 0 ? MENU_CACHE.sandwich_fixins : null;
      for (var sf = 0; sf < fixins.length; sf++) {
        var sfMatch = sandFixinsDB ? fuzzyFindInArray(fixins[sf], sandFixinsDB, "fixin_name") : null;
        var sfid = sfMatch ? sfMatch.modifier_id : null;
        var sfprice = sfMatch ? parseFloat(sfMatch.price || 0) : 0;
        sandExtra += sfprice;
        sandMods.push({name: fixins[sf], modifier_id: sfid, group: "Add Toppings", price: sfprice});
      }
      if (cheese) {
        var ckey = resolveModifier(cheese, CHEESE_IDS);
        var cid = ckey ? CHEESE_IDS[ckey] : null;
        var cprice = ckey ? (CHEESE_PRICES[ckey] || 0) : 0;
        sandExtra += cprice;
        sandMods.push({name: cheese, modifier_id: cid, group: "Cheese Options", price: cprice});
      }
      
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        base_price: parseFloat(match.price_default || 0),
        extra_charges: sandExtra,
        unit_price: round2(parseFloat(match.price_default || 0) + sandExtra),
        modifiers: sandMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── WRAP ──
    if (itemType === "wrap") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Wrap not found. Say the full name like: chicken caesar, veggie, cheese steak, buffalo chicken, chipotle, turkey, tuna.");
      
      var wrapMods = [];
      var wrapExtra = 0;
      var wrapFixinsDB = MENU_CACHE.wrap_fixins.length > 0 ? MENU_CACHE.wrap_fixins : null;
      for (var wf = 0; wf < fixins.length; wf++) {
        var wfMatch = wrapFixinsDB ? fuzzyFindInArray(fixins[wf], wrapFixinsDB, "fixin_name") : null;
        var wfid = wfMatch ? wfMatch.modifier_id : null;
        var wfprice = wfMatch ? parseFloat(wfMatch.price || 0) : 0;
        wrapExtra += wfprice;
        wrapMods.push({name: fixins[wf], modifier_id: wfid, group: "Add Toppings", price: wfprice});
      }
      
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        base_price: parseFloat(match.price_default || 0),
        extra_charges: wrapExtra,
        unit_price: round2(parseFloat(match.price_default || 0) + wrapExtra),
        modifiers: wrapMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── WINGS (buffalo or whole) ──
    if (itemType === "wings" || itemType === "buffalo wings" || itemType === "whole wings") {
      var wingName = (args.item_name || subName || "").toLowerCase();
      var wingQty = parseInt(args.quantity || 0);
      
      // Find wing item by name/quantity
      var match = null;
      var items = MENU_CACHE.items.length > 0 ? MENU_CACHE.items : [];
      for (var wi = 0; wi < items.length; wi++) {
        if (items[wi].item_type === "buffalo_wings" || items[wi].item_type === "whole_wings") {
          var kws = items[wi].keywords || [];
          for (var wk = 0; wk < kws.length; wk++) {
            if (wingName.indexOf(kws[wk]) !== -1) { match = items[wi]; break; }
          }
          if (match) break;
        }
      }
      // Fallback: match by quantity
      if (!match && wingQty > 0) {
        var wType = (itemType === "whole wings" || wingName.indexOf("whole") !== -1) ? "whole_wings" : "buffalo_wings";
        for (var wi2 = 0; wi2 < items.length; wi2++) {
          if (items[wi2].item_type === wType) {
            var numMatch = items[wi2].item_name.match(/(\d+)/);
            if (numMatch && parseInt(numMatch[1]) === wingQty) { match = items[wi2]; break; }
          }
        }
      }
      if (!match) return res.json("ERROR: Wings not found. Buffalo: 6,9,12,18,24,36,48,50. Whole: 4,6,8,10,12,15,20,30.");
      
      var wingMods = [];
      var wingExtra = 0;
      // Flavor
      var flavor = (args.wing_flavor || "").trim();
      if (flavor) {
        var flavorDB = MENU_CACHE.wing_flavors.length > 0 ? MENU_CACHE.wing_flavors : null;
        var flMatch = flavorDB ? fuzzyFindInArray(flavor, flavorDB, "flavor_name") : null;
        var flPrice = flMatch ? parseFloat(flMatch.price || 0) : 0;
        wingExtra += flPrice;
        wingMods.push({name: flavor, modifier_id: flMatch ? flMatch.modifier_id : null, group: "Wings - Flavors", price: flPrice});
      }
      // Dressing
      var dressing = (args.wing_dressing || "").trim();
      if (dressing) {
        var dressDB = MENU_CACHE.wing_dressings.length > 0 ? MENU_CACHE.wing_dressings : null;
        var drMatch = dressDB ? fuzzyFindInArray(dressing, dressDB, "dressing_name") : null;
        var drPrice = drMatch ? parseFloat(drMatch.price || 0) : 0;
        wingExtra += drPrice;
        wingMods.push({name: dressing, modifier_id: drMatch ? drMatch.modifier_id : null, group: "Wings - Dressing", price: drPrice});
      }
      
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        base_price: parseFloat(match.price_default || 0),
        extra_charges: wingExtra,
        unit_price: round2(parseFloat(match.price_default || 0) + wingExtra),
        modifiers: wingMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── SALAD ──
    if (itemType === "salad") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Salad not found. Available: garden, grilled chicken caesar, greek, grilled chicken garden, chef's, tuna, fried shrimp.");
      
      var saladMods = [];
      var saladExtra = 0;
      var saladDress = (args.salad_dressing || "").trim();
      if (saladDress) {
        var sdDB = MENU_CACHE.salad_dressings.length > 0 ? MENU_CACHE.salad_dressings : null;
        var sdMatch = sdDB ? fuzzyFindInArray(saladDress, sdDB, "dressing_name") : null;
        var sdPrice = sdMatch ? parseFloat(sdMatch.price || 0) : 0;
        saladExtra += sdPrice;
        saladMods.push({name: saladDress, modifier_id: sdMatch ? sdMatch.modifier_id : null, group: "Salad Dressing", price: sdPrice});
      }
      // Salad extras (Group 67 in POS)
      var SALAD_EXTRAS = {
        "extra cheese": {id: 504, price: 2.00},
        "extra meat": {id: 502, price: 1.99},
        "add egg": {id: 705, price: 1.00},
        "egg": {id: 705, price: 1.00}
      };
      var saladFixins = args.salad_fixins || fixins || [];
      for (var sx = 0; sx < saladFixins.length; sx++) {
        var sxn = saladFixins[sx].toLowerCase().trim();
        var sxMatch = SALAD_EXTRAS[sxn] || null;
        if (sxMatch) {
          saladExtra += sxMatch.price;
          saladMods.push({name: saladFixins[sx], modifier_id: sxMatch.id, group: "Add Toppings", price: sxMatch.price});
        }
      }
      
      var saladBase = parseFloat(match.price_default || 0);
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        base_price: saladBase,
        extra_charges: saladExtra,
        unit_price: round2(saladBase + saladExtra),
        modifiers: saladMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── GYRO ──
    if (itemType === "gyro") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Gyro not found. Available: chicken gyro, lamb gyro, chicken gyro platter, lamb gyro platter.");
      
      var gyroMods = [];
      var gyroMeat = (args.gyro_meat || "").trim();
      if (gyroMeat) {
        var gmId = gyroMeat.toLowerCase() === "chicken" ? 697 : (gyroMeat.toLowerCase() === "lamb" ? 698 : null);
        gyroMods.push({name: gyroMeat, modifier_id: gmId, group: "Gyro Meat", price: 0});
      }
      // Wrap/gyro fixins
      var gyroExtra = 0;
      var gyroFixinsDB = MENU_CACHE.wrap_fixins.length > 0 ? MENU_CACHE.wrap_fixins : null;
      for (var gf = 0; gf < fixins.length; gf++) {
        var gfMatch = gyroFixinsDB ? fuzzyFindInArray(fixins[gf], gyroFixinsDB, "fixin_name") : null;
        var gfprice = gfMatch ? parseFloat(gfMatch.price || 0) : 0;
        gyroExtra += gfprice;
        gyroMods.push({name: fixins[gf], modifier_id: gfMatch ? gfMatch.modifier_id : null, group: "Add Toppings", price: gfprice});
      }
      
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        base_price: parseFloat(match.price_default || 0),
        extra_charges: gyroExtra,
        unit_price: round2(parseFloat(match.price_default || 0) + gyroExtra),
        modifiers: gyroMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── TENDERS ──
    if (itemType === "tenders" || itemType === "chicken tenders") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Tenders not found. Available: 3 piece, 5 piece, 7 piece.");
      
      var tenderMods = [];
      var sauce = (args.tender_sauce || "").trim();
      if (sauce) {
        var tsDB = MENU_CACHE.tender_sauces.length > 0 ? MENU_CACHE.tender_sauces : null;
        var tsMatch = tsDB ? fuzzyFindInArray(sauce, tsDB, "sauce_name") : null;
        tenderMods.push({name: sauce, modifier_id: tsMatch ? tsMatch.modifier_id : null, group: "Tender Sauce", price: 0});
      }
      
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        unit_price: parseFloat(match.price_default || 0),
        modifiers: tenderMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── DRINK / SODA ──
    if (itemType === "drink" || itemType === "beverage" || itemType === "soda") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Drink not found. Available: can soda, 2 liter soda, water, lemonade, apple juice, orange juice, cranberry juice.");
      
      var drinkMods = [];
      var sodaFl = (args.soda_flavor || "").trim();
      if (sodaFl) {
        var sfDB = MENU_CACHE.soda_flavors.length > 0 ? MENU_CACHE.soda_flavors : null;
        var sfMatch = sfDB ? fuzzyFindInArray(sodaFl, sfDB, "flavor_name") : null;
        drinkMods.push({name: sodaFl, modifier_id: sfMatch ? sfMatch.modifier_id : null, group: "Soda Can", price: 0});
      }
      
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        unit_price: parseFloat(match.price_default || 0),
        modifiers: drinkMods,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── STROMBOLI (uses 12" pizza topping prices) ──
    if (itemType === "stromboli") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Stromboli not found. Available: Regular Cheese and Beef, Veggie, Philly Cheese Steak, Chicken.");
      
      var stBase = parseFloat(match.price_default || 0);
      var stResult = buildModifiers(toppings, 12, 0);
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: "Stromboli",
        base_price: stBase,
        topping_charges: stResult.extra_charge,
        unit_price: round2(stBase + stResult.extra_charge),
        modifiers: stResult.modifiers,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── QUESADILLA (uses 12" pizza topping prices) ──
    if (itemType === "quesadilla") {
      var match = findMenuItem(subName || args.item_name || "");
      if (!match) return res.json("ERROR: Quesadilla not found. Available: Chicken Breast, Buffalo Chicken, Steak, Veggie, Shrimp.");
      
      var qBase = parseFloat(match.price_default || 0);
      var qResult = buildModifiers(toppings, 12, 0);
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        base_price: qBase,
        topping_charges: qResult.extra_charge,
        unit_price: round2(qBase + qResult.extra_charge),
        modifiers: qResult.modifiers,
        special_instructions: specialInstructions || undefined
      });
    }

    // ── GENERIC LOOKUP (sides, desserts, pasta, clubs, nuggets, seafood, platters) ──
    var match = findMenuItem(subName || args.item_name || itemType);
    if (match) {
      return res.json({
        item_name: match.item_name,
        item_id: match.pos_id,
        category: match.category,
        unit_price: parseFloat(match.price_default || match.price_8 || match.price_10 || 0),
        modifiers: [],
        special_instructions: specialInstructions || undefined
      });
    }

    return res.json("ERROR: Item not found. Tell me the exact item name.");
  } catch (e) {
    console.error("calculate_price error:", e);
    return res.json("ERROR: " + e.message);
  }
});

// ═══════════════════════════════════════════════════
// TOOL 2: calculate_combo — for combo deals
// Handles all topping math, free topping rules, ID lookups
// ═══════════════════════════════════════════════════
app.post("/retell/function/calculate_combo", function (req, res) {
  try {
    var args = req.body.args || req.body;
    var dealType = (args.deal_type || "").toLowerCase().trim();
    var pizzaSize = parseInt(args.pizza_size || 0);
    var pizzas = args.pizzas || []; // [{toppings:[{name,half}]}]
    var subName = (args.sub_name || "").trim();
    var subSize = (args.sub_size || "half").toLowerCase();
    var subFixins = args.sub_fixins || [];
    var subCheese = (args.sub_cheese || "").trim();
    var subSpecial = (args.sub_special_instructions || "").trim();
    var wingFlavor = (args.wing_flavor || "").trim();
    var wingDressing = (args.wing_dressing || "").trim();
    var sodaFlavor = (args.soda_flavor || "").trim();
    var sodaFlavor2 = (args.soda_flavor_2 || "").trim();
    var twoLiterFlavor = (args.two_liter_flavor || "").trim();
    var friesUpgrade = (args.fries_upgrade || "").toLowerCase().trim();

    // Special/premium subs NOT allowed in pizza+sub, combo deal, or wings+sub deals
    var PREMIUM_SUB_IDS = [723, 724, 725, 726, 710];
    var PREMIUM_EXCLUDED_DEALS = ["pizza and sub", "pizza sub combo", "combo deal", "pizza sub wings", "wings and sub", "wings sub combo"];
    if (subName && PREMIUM_EXCLUDED_DEALS.indexOf(dealType) !== -1) {
      var premCheck = matchSub(subName);
      if (premCheck && PREMIUM_SUB_IDS.indexOf(premCheck.id) !== -1) {
        return res.json("ERROR: " + premCheck.name + " is a premium sub and cannot be used in " + dealType + ". Only regular subs qualify. This sub can be made into a Sub Combo (sub + fries + can soda) instead. Use deal_type 'sub combo'.");
      }
    }

    // Find deal
    var deal = COMBO_DB[dealType];
    if (!deal) {
      var available = Object.keys(COMBO_DB).join(", ");
      return res.json("ERROR: Deal not found. Available deals: " + available);
    }

    // Find size entry
    var sizeKey = pizzaSize || (subSize === "whole" || subSize === "12" ? 12 : 8);
    if (dealType.indexOf("sub combo") !== -1 && !pizzaSize) sizeKey = (subSize === "whole" || subSize === "12") ? 12 : 8;
    if (!pizzaSize && deal.pizzas === 0 && deal.sizes[0]) sizeKey = 0;
    
    var sizeEntry = deal.sizes[sizeKey] || deal.sizes[pizzaSize];
    if (!sizeEntry) {
      var availSizes = Object.keys(deal.sizes).join(", ");
      return res.json("ERROR: Size " + sizeKey + " not available for " + dealType + ". Available sizes: " + availSizes);
    }

    var basePrice = sizeEntry.price;
    var dealId = sizeEntry.id;
    var totalExtra = 0;
    var components = [];
    var freeToppings = deal.freeToppings || 0;

    // ── Build pizza components ──
    var pizzaIds = {10:735, 12:736, 14:737, 16:738, 18:739};
    var sizeLabels = {10:"Sm",12:"Med",14:"Lrg",16:"XL",18:"XXL"};
    
    for (var p = 0; p < pizzas.length; p++) {
      var pizzaToppings = pizzas[p].toppings || [];
      var pizzaSpecial = pizzas[p].special_instructions || "";
      var result = buildModifiers(pizzaToppings, pizzaSize, freeToppings);
      totalExtra += result.extra_charge;
      
      var comp = {
        component_name: pizzaSize + " inch " + (sizeLabels[pizzaSize]||"") + " Cheese Pizza",
        item_id: String(pizzaIds[pizzaSize] || 737),
        category: "Pizzas",
        modifiers: result.modifiers
      };
      if (pizzaSpecial) comp.special_instructions = pizzaSpecial;
      components.push(comp);
    }

    // ── Build sub component ──
    if (subName) {
      var sub = matchSub(subName);
      if (!sub) return res.json("ERROR: Sub not found: " + subName + ". Check spelling. Available: cheese steak, shrimp cheese steak, philly cheese steak, italian cold cut, turkey breast, etc.");
      
      var is12 = (subSize === "whole" || subSize === "12");
      var prefix = is12 ? "12 inch Whole " : "8 inch Half ";
      var subMods = [];
      var subExtra = 0;
      
      for (var sf = 0; sf < subFixins.length; sf++) {
        var sfkey = resolveModifier(subFixins[sf], SUB_FIXINS_IDS);
        var sfid = sfkey ? SUB_FIXINS_IDS[sfkey] : null;
        var sfprice = sfkey ? (SUB_FIXINS_PRICES[sfkey] || 0) : 0;
        subExtra += sfprice;
        subMods.push({name: subFixins[sf], modifier_id: sfid, group: "Sub Fixins", price: sfprice});
      }
      if (subCheese) {
        var sckey = resolveModifier(subCheese, CHEESE_IDS);
        var scid = sckey ? CHEESE_IDS[sckey] : null;
        var scprice = sckey ? (CHEESE_PRICES[sckey] || 0) : 0;
        subExtra += scprice;
        subMods.push({name: subCheese, modifier_id: scid, group: "Cheese Options", price: scprice});
      }
      totalExtra += subExtra;
      
      var subComp = {
        component_name: prefix + sub.name,
        item_id: String(sub.id),
        category: "Submarines",
        modifiers: subMods
      };
      if (subSpecial) subComp.special_instructions = subSpecial;
      components.push(subComp);
    }

    // ── Build wings component ──
    if (wingFlavor) {
      var wingCount = deal.wings || (dealType.indexOf("combo deal") !== -1 ? (pizzaSize <= 12 ? 6 : 8) : 0);
      if (dealType.indexOf("wings and sub") !== -1) wingCount = 6;
      if (dealType.indexOf("wings special buffalo") !== -1) wingCount = 6;
      if (dealType.indexOf("wings special whole") !== -1) wingCount = 4;
      if (dealType.indexOf("chicken box whole") !== -1) wingCount = 4;
      if (dealType.indexOf("chicken box buffalo") !== -1) wingCount = 6;
      
      var wingIds = {6:579,8:580,9:580,10:581,12:581,48:585};
      var wholeIds = {4:591,6:592};
      var isWhole = dealType.indexOf("whole") !== -1;
      var wid = isWhole ? (wholeIds[wingCount] || 591) : (wingIds[wingCount] || 579);
      var wType = isWhole ? "Whole" : "Buffalo";
      
      var wingMods = [{name: wingFlavor, group: "Wings - Flavors", price: 0}];
      if (wingDressing) wingMods.push({name: wingDressing, group: "Wings - Dressing", price: 0});
      
      components.push({
        component_name: wingCount + "pcs " + wType + " wings",
        item_id: String(wid),
        category: "Wings",
        modifiers: wingMods
      });
    }

    // ── Build fries component ──
    if (deal.includes_fries) {
      var FRIES_UPGRADES = {
        "western fries": {name:"Western Fries Large", id:"608"},
        "western": {name:"Western Fries Large", id:"608"},
        "cheese fries": {name:"Fries with Cheese", id:"811"},
        "fries with cheese": {name:"Fries with Cheese", id:"811"},
        "nacho fries": {name:"Fries with Nacho", id:"611"},
        "fries with nacho": {name:"Fries with Nacho", id:"611"},
        "gravy fries": {name:"Fries with Gravy", id:"609"},
        "fries with gravy": {name:"Fries with Gravy", id:"609"},
        "mozzarella fries": {name:"Fries with Mozzarella", id:"612"},
        "fries with mozzarella": {name:"Fries with Mozzarella", id:"612"},
        "pizza fries": {name:"Pizza Fries", id:"615"},
        "crazy fries": {name:"Crazy Fries", id:"613"},
        "large fries": {name:"Large French Fries", id:"830"}
      };
      if (friesUpgrade && FRIES_UPGRADES[friesUpgrade]) {
        var upgrade = FRIES_UPGRADES[friesUpgrade];
        totalExtra += 2.00;
        components.push({component_name: upgrade.name + " +$2.00 upgrade", item_id: upgrade.id, category: "Sides"});
      } else {
        components.push({component_name: "French Fries", item_id: "607", category: "Sides"});
      }
    }

    // ── Build soda components ──
    if (deal.includes_can || sodaFlavor) {
      if (sodaFlavor) {
        var sodaMods = [{name: sodaFlavor, group: "Soda Can", price: 0}];
        components.push({component_name: "Can Soda", item_id: "728", category: "Beverages", modifiers: sodaMods});
      }
      if (sodaFlavor2) {
        var sodaMods2 = [{name: sodaFlavor2, group: "Soda Can", price: 0}];
        components.push({component_name: "Can Soda", item_id: "728", category: "Beverages", modifiers: sodaMods2});
      }
    }
    if (deal.includes_2l || twoLiterFlavor) {
      if (twoLiterFlavor) {
        var tlMods = [{name: twoLiterFlavor, group: "Soda Can", price: 0}];
        components.push({component_name: "2 Liter Soda", item_id: "790", category: "Beverages", modifiers: tlMods});
      }
    }

    // ── Burger/Fish combo ──
    if (dealType === "burger combo") {
      components.push({component_name: "Cheese Burger Sandwich", item_id: "713", category: "Sandwiches", modifiers: []});
      // Fries and soda handled by generic sections above
    }
    if (dealType === "fish combo") {
      components.push({component_name: "Cheese Fish Sandwich", item_id: "718", category: "Sandwiches", modifiers: []});
      // Fries and soda handled by generic sections above
    }

    var unitPrice = Math.round((basePrice + totalExtra) * 100) / 100;

    // Build proper item_name for POS display
    var DEAL_DISPLAY_NAMES = {
      "double deal": "Double Deal",
      "3 pizza special": "3-Pizza Special",
      "three pizza special": "3-Pizza Special",
      "pizza and wings": "Pizza and Wings Deal",
      "family deal": "Pizza and Wings Deal",
      "pizza and sub": "Pizza and Sub Combo",
      "pizza sub combo": "Pizza and Sub Combo",
      "combo deal": "Combo Deal",
      "pizza sub wings": "Combo Deal",
      "sub combo": "Sub Combo",
      "2 sub combo": "2 Sub Combo",
      "two sub combo": "2 Sub Combo",
      "3 sub combo": "3 Sub Combo",
      "three sub combo": "3 Sub Combo",
      "wings and sub": "Wings and Sub Combo",
      "wings sub combo": "Wings and Sub Combo",
      "wings special buffalo": "Buffalo Wings Special",
      "wings special whole": "Whole Wings Special",
      "chicken box whole": "Chicken Box",
      "chicken box buffalo": "Chicken Box",
      "burger combo": "Burger Combo",
      "fish combo": "Fish Combo",
      "party deal": "Party Deal",
      "fish and wings deal": "Fish and Wings Deal"
    };
    var displayName = DEAL_DISPLAY_NAMES[dealType] || dealType;
    if (pizzaSize) displayName += " " + pizzaSize + " inch";
    if (dealType.indexOf("sub combo") !== -1 && !pizzaSize) {
      var subSizeLabel = (subSize === "whole" || subSize === "12") ? "12 inch" : "8 inch";
      displayName += " " + subSizeLabel;
    }

    // Build breakdown text for agent to read
    var breakdown = "Base deal price: $" + basePrice.toFixed(2);
    if (totalExtra > 0) breakdown += " + extra charges: $" + totalExtra.toFixed(2);
    breakdown += " = Total: $" + unitPrice.toFixed(2);

    return res.json({
      item_name: displayName,
      deal_name: dealType,
      deal_id: dealId,
      base_price: basePrice,
      extra_charges: totalExtra,
      unit_price: unitPrice,
      components: components,
      breakdown: breakdown,
      tax: Math.round(unitPrice * CONFIG.TAX_RATE * 100) / 100,
      total_with_tax: Math.round(unitPrice * (1 + CONFIG.TAX_RATE) * 100) / 100
    });

  } catch (e) {
    console.error("calculate_combo error:", e);
    return res.json("ERROR: " + e.message);
  }
});

// ═══ DATABASE MANAGEMENT ENDPOINTS ═══
app.get("/reload-menu", async function (req, res) {
  var ok = await loadMenuFromDB();
  res.json({ reloaded: ok, status: DB_STATUS, loaded_from: MENU_CACHE.loaded_from, loaded_at: MENU_CACHE.loaded_at,
    counts: { items: MENU_CACHE.items.length, toppings: MENU_CACHE.toppings.length, deals: MENU_CACHE.combo_deals.length }
  });
});

app.get("/test-db", function (req, res) {
  res.json({
    db_status: DB_STATUS,
    loaded_from: MENU_CACHE.loaded_from,
    loaded_at: MENU_CACHE.loaded_at,
    counts: {
      items: MENU_CACHE.items.length,
      toppings: MENU_CACHE.toppings.length,
      sub_fixins: MENU_CACHE.sub_fixins.length,
      cheese_options: MENU_CACHE.cheese_options.length,
      wing_flavors: MENU_CACHE.wing_flavors.length,
      soda_flavors: MENU_CACHE.soda_flavors.length,
      combo_deals: MENU_CACHE.combo_deals.length
    },
    sample_sub: SUBS_DB.slice(0, 3).map(function(s) { return s.name + " [" + s.id + "] $" + s.p8; }),
    sample_deal: Object.keys(COMBO_DB).slice(0, 3)
  });
});

app.listen(CONFIG.PORT, function () { console.log("V16 POS Bridge | Port: " + CONFIG.PORT + " | ID: " + CONFIG.RESTAURANT_ID + " | DB: " + DB_STATUS); });

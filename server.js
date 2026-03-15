const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — Edit these values for your restaurant. No external files needed.
// Secrets come from Render environment variables.
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  name: "Pizza Demo",
  address: "4195 Main St, Reston VA 20191",
  lat: 38.9586, lng: -77.3570,
  tax: 0.06,
  delivery: { fee: 1.95, min: 10, maxMiles: 4 },
  pos: {
    endpoint: process.env.POS_ENDPOINT || "https://www.mealage.us/aivoice/orders.jsp",
    id: process.env.POS_RESTAURANT_ID || "8000",
    pw: process.env.POS_PASSWORD || "126790"
  },
  gmaps: process.env.GOOGLE_MAPS_API_KEY || ""
};

// ═══════════════════════════════════════════════════════════════════════════
// MENU DATA — All items, modifiers, combos, synonyms inline
// ═══════════════════════════════════════════════════════════════════════════

const MENU = [
  // CHEESE PIZZAS
  {id:"735",key:"cheese_pizza_10",name:'10" Small Cheese Pizza',cat:"pizza",size:"10",price:8.99,mods:["toppings"]},
  {id:"736",key:"cheese_pizza_12",name:'12" Medium Cheese Pizza',cat:"pizza",size:"12",price:10.99,mods:["toppings"]},
  {id:"737",key:"cheese_pizza_14",name:'14" Large Cheese Pizza',cat:"pizza",size:"14",price:11.99,mods:["toppings"]},
  {id:"738",key:"cheese_pizza_16",name:'16" X-Large Cheese Pizza',cat:"pizza",size:"16",price:13.99,mods:["toppings"]},
  {id:"739",key:"cheese_pizza_18",name:'18" XX-Large Cheese Pizza',cat:"pizza",size:"18",price:14.99,mods:["toppings"]},
  // SPECIALTY PIZZAS (12/14/16)
  {id:"655",key:"deluxe_12",name:'12" Deluxe Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"655",key:"deluxe_14",name:'14" Deluxe Pizza',cat:"pizza",size:"14",price:17.99,mods:[]},
  {id:"655",key:"deluxe_16",name:'16" Deluxe Pizza',cat:"pizza",size:"16",price:19.99,mods:[]},
  {id:"658",key:"supreme_12",name:'12" Supreme Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"658",key:"supreme_14",name:'14" Supreme Pizza',cat:"pizza",size:"14",price:17.99,mods:[]},
  {id:"658",key:"supreme_16",name:'16" Supreme Pizza',cat:"pizza",size:"16",price:19.99,mods:[]},
  {id:"659",key:"veggie_12",name:'12" Veggie Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"661",key:"hawaiian_12",name:'12" Hawaiian Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"661",key:"hawaiian_14",name:'14" Hawaiian Pizza',cat:"pizza",size:"14",price:17.99,mods:[]},
  {id:"662",key:"ny_style_12",name:'12" New York Style Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"663",key:"chk_bacon_ranch_12",name:'12" Chicken Bacon Ranch Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"665",key:"bbq_chicken_12",name:'12" BBQ Chicken Pizza',cat:"pizza",size:"12",price:14.99,mods:[]},
  {id:"665",key:"bbq_chicken_14",name:'14" BBQ Chicken Pizza',cat:"pizza",size:"14",price:17.99,mods:[]},
  {id:"666",key:"meat_buster_14",name:'14" Meat Buster Pizza',cat:"pizza",size:"14",price:17.99,mods:[]},
  {id:"660",key:"philly_steak_pizza_14",name:'14" Philly Cheesesteak Pizza',cat:"pizza",size:"14",price:17.99,mods:[]},
  // BUFFALO WINGS
  {id:"579",key:"bwings_6",name:"6pc Buffalo Wings",cat:"buffalo_wings",size:"6",price:8.99,mods:["wing_flavor","wing_dressing"],pc:6},
  {id:"580",key:"bwings_9",name:"9pc Buffalo Wings",cat:"buffalo_wings",size:"9",price:12.99,mods:["wing_flavor","wing_dressing"],pc:9},
  {id:"581",key:"bwings_12",name:"12pc Buffalo Wings",cat:"buffalo_wings",size:"12",price:14.99,mods:["wing_flavor","wing_dressing"],pc:12},
  {id:"582",key:"bwings_18",name:"18pc Buffalo Wings",cat:"buffalo_wings",size:"18",price:21.99,mods:["wing_flavor","wing_dressing"],pc:18},
  {id:"583",key:"bwings_24",name:"24pc Buffalo Wings",cat:"buffalo_wings",size:"24",price:25.99,mods:["wing_flavor","wing_dressing"],pc:24},
  {id:"584",key:"bwings_36",name:"36pc Buffalo Wings",cat:"buffalo_wings",size:"36",price:36.99,mods:["wing_flavor","wing_dressing"],pc:36},
  {id:"585",key:"bwings_48",name:"48pc Buffalo Wings",cat:"buffalo_wings",size:"48",price:46.99,mods:["wing_flavor","wing_dressing"],pc:48},
  {id:"586",key:"bwings_50",name:"50pc Buffalo Wings",cat:"buffalo_wings",size:"50",price:48.99,mods:["wing_flavor","wing_dressing"],pc:50},
  // placeholder for combo-specific counts
  {id:"579b",key:"bwings_8",name:"8pc Buffalo Wings",cat:"buffalo_wings",size:"8",price:10.99,mods:["wing_flavor","wing_dressing"],pc:8},
  {id:"579c",key:"bwings_10",name:"10pc Buffalo Wings",cat:"buffalo_wings",size:"10",price:12.99,mods:["wing_flavor","wing_dressing"],pc:10},
  // WHOLE WINGS
  {id:"591",key:"wwings_4",name:"4pc Whole Wings",cat:"whole_wings",size:"4",price:9.99,mods:["wing_flavor","wing_dressing"],pc:4},
  {id:"592",key:"wwings_6",name:"6pc Whole Wings",cat:"whole_wings",size:"6",price:12.99,mods:["wing_flavor","wing_dressing"],pc:6},
  {id:"593",key:"wwings_8",name:"8pc Whole Wings",cat:"whole_wings",size:"8",price:15.99,mods:["wing_flavor","wing_dressing"],pc:8},
  {id:"594",key:"wwings_10",name:"10pc Whole Wings",cat:"whole_wings",size:"10",price:15.99,mods:["wing_flavor","wing_dressing"],pc:10},
  // NUGGETS / TENDERS
  {id:"587",key:"nuggets_6",name:"6pc Chicken Nuggets",cat:"other",size:"6",price:5.99,mods:[]},
  {id:"588",key:"nuggets_9",name:"9pc Chicken Nuggets",cat:"other",size:"9",price:6.99,mods:[]},
  {id:"672",key:"tenders_3",name:"3pc Chicken Tenders",cat:"other",size:"3",price:7.49,mods:[]},
  {id:"673",key:"tenders_5",name:"5pc Chicken Tenders",cat:"other",size:"5",price:10.49,mods:[]},
  {id:"674",key:"tenders_7",name:"7pc Chicken Tenders",cat:"other",size:"7",price:12.49,mods:[]},
  // SUBS
  {id:"684",key:"cheesesteak_8",name:'8" Cheese Steak Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"684",key:"cheesesteak_12",name:'12" Cheese Steak Sub',cat:"sub",size:"12",price:12.99,mods:["sub_fixins","cheese"]},
  {id:"685",key:"chk_cheesesteak_8",name:'8" Chicken Cheese Steak Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"685",key:"chk_cheesesteak_12",name:'12" Chicken Cheese Steak Sub',cat:"sub",size:"12",price:12.99,mods:["sub_fixins","cheese"]},
  {id:"689",key:"meatball_8",name:'8" Meatball Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"689",key:"meatball_12",name:'12" Meatball Sub',cat:"sub",size:"12",price:12.99,mods:["sub_fixins","cheese"]},
  {id:"692",key:"grilled_chk_8",name:'8" Grilled Chicken Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"691",key:"chk_parm_8",name:'8" Chicken Parmesan Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"694",key:"pizza_sub_8",name:'8" Pizza Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"690",key:"turkey_burger_sub_8",name:'8" Turkey Burger Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"702",key:"italian_cold_8",name:'8" Italian Cold Cut',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"704",key:"turkey_breast_8",name:'8" Turkey Breast Cold Cut',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  {id:"706",key:"tuna_salad_8",name:'8" Tuna Salad Cold Cut',cat:"sub",size:"8",price:9.99,mods:["sub_fixins","cheese"]},
  {id:"723",key:"philly_steak_8",name:'8" Philly Cheese Steak Sub',cat:"sub",size:"8",price:9.99,mods:["sub_fixins","cheese"]},
  {id:"727",key:"veggie_sub_8",name:'8" Veggie Sub',cat:"sub",size:"8",price:9.99,mods:["sub_fixins","cheese"]},
  {id:"801",key:"cheese_fish_sub_8",name:'8" Cheese Fish Sub',cat:"sub",size:"8",price:8.49,mods:["sub_fixins","cheese"]},
  // SANDWICHES
  {id:"713",key:"cheeseburger",name:"Cheese Burger Sandwich",cat:"sandwich",size:"",price:4.99,mods:["sub_fixins","cheese"]},
  {id:"712",key:"hamburger",name:"Hamburger 1/4lb",cat:"sandwich",size:"",price:4.99,mods:["sub_fixins","cheese"]},
  {id:"715",key:"grilled_chk_sand",name:"Grilled Chicken Sandwich",cat:"sandwich",size:"",price:5.99,mods:["sub_fixins","cheese"]},
  {id:"720",key:"cheese_fish_sand",name:"Cheese Fish Sandwich",cat:"sandwich",size:"",price:5.99,mods:["sub_fixins","cheese"]},
  // BEVERAGES
  {id:"728c",key:"soda_can",name:"Soda Can",cat:"soda",size:"can",price:1.00,mods:["soda_flavor"]},
  {id:"728b",key:"soda_20oz",name:"20oz Soda Bottle",cat:"soda",size:"20oz",price:2.25,mods:["soda_flavor"]},
  {id:"728l",key:"soda_2liter",name:"2-Liter Soda",cat:"soda",size:"2liter",price:3.49,mods:["soda_flavor"]},
  {id:"732",key:"water",name:"Spring Water",cat:"other",size:"",price:1.29,mods:[]},
  {id:"729",key:"apple_juice",name:"Apple Juice",cat:"other",size:"",price:3.25,mods:[]},
  {id:"730",key:"oj",name:"Orange Juice",cat:"other",size:"",price:3.25,mods:[]},
  // SIDES
  {id:"607",key:"fries",name:"French Fries",cat:"fries",size:"reg",price:2.99,mods:[]},
  {id:"830",key:"lg_fries",name:"Large French Fries",cat:"fries",size:"lg",price:4.49,mods:[]},
  {id:"616",key:"mozz_sticks",name:"Mozzarella Sticks",cat:"other",size:"",price:6.49,mods:[]},
  {id:"618",key:"onion_rings",name:"Onion Rings",cat:"other",size:"",price:3.49,mods:[]},
  {id:"621",key:"garlic_bread",name:"Garlic Bread",cat:"other",size:"",price:3.50,mods:[]},
  {id:"622",key:"garlic_bread_chz",name:"Garlic Bread with Cheese",cat:"other",size:"",price:4.50,mods:[]},
  {id:"620",key:"breadsticks",name:"Breadsticks",cat:"other",size:"",price:4.99,mods:[]},
  {id:"613",key:"crazy_fries",name:"Crazy Fries",cat:"other",size:"",price:6.99,mods:[]},
  // SALADS
  {id:"633",key:"greek_salad",name:"Greek Salad",cat:"salad",size:"",price:9.99,mods:["salad_dressing"]},
  {id:"634",key:"caesar_salad",name:"Grilled Chicken Caesar Salad",cat:"salad",size:"",price:7.99,mods:["salad_dressing"]},
  {id:"635",key:"garden_salad",name:"Garden Salad",cat:"salad",size:"",price:6.99,mods:["salad_dressing"]},
  {id:"636",key:"grilled_chk_garden",name:"Grilled Chicken Garden Salad",cat:"salad",size:"",price:9.99,mods:["salad_dressing"]},
  // PASTA
  {id:"570",key:"meat_spaghetti",name:"Meat Sauce Spaghetti",cat:"pasta",size:"",price:10.99,mods:[]},
  {id:"571",key:"meat_lasagna",name:"Meat Sauce Lasagna",cat:"pasta",size:"",price:11.99,mods:[]},
  {id:"576",key:"chk_alfredo",name:"Chicken Alfredo Pasta",cat:"pasta",size:"",price:9.99,mods:[]},
  {id:"577",key:"shrimp_alfredo",name:"Shrimp Alfredo Pasta",cat:"pasta",size:"",price:12.99,mods:[]},
  {id:"572",key:"chk_parm_spag",name:"Chicken Parmesan Spaghetti",cat:"pasta",size:"",price:10.99,mods:[]},
  // SEAFOOD
  {id:"642",key:"tilapia_2",name:"Tilapia 2pc",cat:"seafood",size:"",price:10.99,mods:[]},
  {id:"643",key:"tilapia_3",name:"Tilapia 3pc",cat:"seafood",size:"",price:13.99,mods:[]},
  {id:"645",key:"catfish_2",name:"Catfish 2pc",cat:"seafood",size:"",price:9.99,mods:[]},
  {id:"651",key:"lake_trout_3",name:"Lake Trout 3pc",cat:"seafood",size:"",price:14.99,mods:[]},
  {id:"675",key:"jumbo_shrimp",name:"Jumbo Shrimp 8pc",cat:"seafood",size:"",price:12.99,mods:[]},
  // WRAPS
  {id:"623",key:"caesar_wrap",name:"Grilled Chicken Caesar Wrap",cat:"other",size:"",price:9.49,mods:[]},
  {id:"625",key:"steak_wrap",name:"Cheese Steak Wrap",cat:"other",size:"",price:9.49,mods:[]},
  {id:"629",key:"buff_chk_wrap",name:"Buffalo Chicken Wrap",cat:"other",size:"",price:9.49,mods:[]},
  // GYROS
  {id:"653",key:"chk_gyro",name:"Chicken Gyro",cat:"other",size:"",price:9.49,mods:["gyro_meat"]},
  {id:"654",key:"lamb_gyro",name:"Lamb Gyro",cat:"other",size:"",price:9.49,mods:["gyro_meat"]},
  // QUESADILLAS
  {id:"678",key:"chk_quesadilla",name:"Chicken Breast Quesadilla",cat:"other",size:"",price:10.99,mods:[]},
  {id:"680",key:"steak_quesadilla",name:"Steak Quesadilla",cat:"other",size:"",price:10.99,mods:[]},
  // STROMBOLI
  {id:"668",key:"stromboli_reg",name:"Regular Cheese & Beef Stromboli",cat:"other",size:"",price:9.99,mods:[]},
  {id:"670",key:"philly_stromboli",name:"Philly Cheese Steak Stromboli",cat:"other",size:"",price:14.99,mods:[]},
  // DESSERTS
  {id:"601",key:"cheesecake",name:"Cheese Cake",cat:"dessert",size:"",price:3.99,mods:[]},
  {id:"602",key:"choc_cake",name:"Chocolate Cake",cat:"dessert",size:"",price:3.99,mods:[]},
  {id:"605",key:"strawberry_chzcake",name:"Strawberry Cheesecake",cat:"dessert",size:"",price:4.99,mods:[]},
  {id:"606",key:"red_velvet",name:"Red Velvet Cake",cat:"dessert",size:"",price:3.99,mods:[]},
];

const MODIFIERS = {
  wing_flavor: {q:"What flavor on the wings?",opts:["Southern Style","BBQ","Honey BBQ","Hot","Mild","Extra Hot","Lemon Pepper","Old Bay","Honey Old Bay","Honey Lemon Pepper","Honey Mustard","Honey Garlic","Bourbon","Mango Habanero","Caribbean Jerk","General Tso's","Jamaican Jerk","Spicy BBQ","Thai Chili","Toxic Waste","Garlic Parmesan","Maryland Style","Spicy Honey BBQ","Roasted Garlic","No Flavor"]},
  wing_dressing: {q:"Ranch or blue cheese?",opts:["Ranch","Blue Cheese","Hot Sauce"]},
  sub_fixins: {q:"What would you like on it? Or everything?",opts:["Everything","Everything NO HOTS","Lettuce","Tomatoes","Mayo","Mustard","Ketchup","Onions","Hot Peppers","Raw Onions","Grilled Onions","Pickles","Salt & Pepper"]},
  cheese: {q:"What kind of cheese?",opts:["American","Provolone","Mozzarella","Feta","No Cheese"]},
  soda_flavor: {q:"What kind of soda?",opts:["Pepsi","Coke","Sprite","Dr Pepper","Mountain Dew","Diet Pepsi","Diet Coke","Cherry Coke","Fanta Orange","Fanta Grape","Lemonade","Root Beer","Ginger Ale","Coke Zero","Sierra Mist","Brisk","Fruit Punch"]},
  salad_dressing: {q:"What dressing?",opts:["Ranch","Blue Cheese","Creamy Italian","Thousand Island","Caesar","Balsamic Vinaigrette","French"]},
  toppings: {q:"What toppings?",opts:["Pepperoni","Sausage","Ground Beef","Ham","Bacon","Chicken","Mushrooms","Onions","Green Peppers","Black Olives","Jalapeños","Pineapple","Tomatoes","Spinach","Broccoli","Extra Cheese","Extra Sauce","Shrimp","Anchovi"]},
  gyro_meat: {q:"Chicken or lamb?",opts:["Chicken","Lamb"]}
};

const SYNONYMS = {
  "large pizza":"cheese_pizza_14","large pepperoni":"cheese_pizza_14","extra large pizza":"cheese_pizza_16",
  "medium pizza":"cheese_pizza_12","small pizza":"cheese_pizza_10","cheesesteak":"cheesesteak_8",
  "cheese steak":"cheesesteak_8","chicken cheesesteak":"chk_cheesesteak_8","chicken cheese steak":"chk_cheesesteak_8",
  "meatball sub":"meatball_8","meatball":"meatball_8","philly cheesesteak":"philly_steak_8","philly":"philly_steak_8",
  "grilled chicken sub":"grilled_chk_8","italian cold cut":"italian_cold_8","turkey sub":"turkey_breast_8",
  "buffalo wings":"bwings","wings":"bwings","whole wings":"wwings","nuggets":"nuggets","tenders":"tenders",
  "fries":"fries","french fries":"fries","mozzarella sticks":"mozz_sticks","mozz sticks":"mozz_sticks",
  "onion rings":"onion_rings","garlic bread":"garlic_bread","water":"water",
  "garden salad":"garden_salad","caesar salad":"caesar_salad","greek salad":"greek_salad",
  "chicken alfredo":"chk_alfredo","alfredo":"chk_alfredo","spaghetti":"meat_spaghetti","lasagna":"meat_lasagna",
  "gyro":"chk_gyro","chicken gyro":"chk_gyro","lamb gyro":"lamb_gyro",
  "cheeseburger":"cheeseburger","hamburger":"hamburger","coke":"soda_can","pepsi":"soda_can","sprite":"soda_can",
  "dr pepper":"soda_can","deluxe pizza":"deluxe","supreme pizza":"supreme","hawaiian pizza":"hawaiian",
  "veggie pizza":"veggie","bbq chicken pizza":"bbq_chicken","meat buster":"meat_buster"
};

// ═══════════════════════════════════════════════════════════════════════════
// CART — in-memory per call_id
// ═══════════════════════════════════════════════════════════════════════════

const carts = {};
const getCart = (id) => { if(!carts[id]) carts[id]={items:[],t:Date.now()}; return carts[id]; };
setInterval(()=>{const n=Date.now();for(const[k,v]of Object.entries(carts))if(n-v.t>3600000)delete carts[k];},1800000);

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const args = (req) => { const b=req.body||{}; return { a: b.args||b, cid: b.call_id||'def' }; };
const send = (res, r) => res.json({ result: typeof r==='string'?r:JSON.stringify(r) });
const esc = (s) => !s?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function findItems(query) {
  const q = query.toLowerCase().trim();
  const results = [];
  // synonym check
  for (const [syn, key] of Object.entries(SYNONYMS)) {
    if (q.includes(syn)) {
      const m = MENU.filter(i => i.key === key || i.key.startsWith(key));
      results.push(...m);
    }
  }
  if (results.length === 0) {
    for (const item of MENU) {
      const s = `${item.name} ${item.cat} ${item.key}`.toLowerCase();
      if (s.includes(q) || q.split(' ').every(w => s.includes(w))) results.push(item);
    }
  }
  const seen = new Set();
  return results.filter(r => { if(seen.has(r.key))return false; seen.add(r.key); return true; }).slice(0,8);
}

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  status:'running', env:{
    POS_ID:process.env.POS_RESTAURANT_ID?'✓':'✗',
    POS_PW:process.env.POS_PASSWORD?'✓':'✗',
    GMAPS:process.env.GOOGLE_MAPS_API_KEY?'✓':'✗'
  }
}));

// 1. SEARCH MENU
app.post('/retell/function/search_menu', (req, res) => {
  const { a } = args(req);
  const items = findItems(a.query || '');
  if (!items.length) return send(res, `No items found for "${a.query}". Try pizza, wings, subs, salads, pasta, or seafood.`);
  send(res, { found:true, items: items.map(i=>({item_id:i.id,name:i.name,size:i.size,price:i.price,category:i.cat,required_modifiers:i.mods})) });
});

// 2. GET ITEM DETAILS
app.post('/retell/function/get_item_details', (req, res) => {
  const { a } = args(req);
  const item = MENU.find(i => i.id===a.item_id || i.key===a.item_id);
  if (!item) return send(res, 'Item not found.');
  const mods = item.mods.map(k => MODIFIERS[k] ? {group:k,question:MODIFIERS[k].q,options:MODIFIERS[k].opts.slice(0,10).join(', ')} : null).filter(Boolean);
  send(res, {item_id:item.id,name:item.name,size:item.size,price:item.price,category:item.cat,required_modifiers:mods});
});

// 3. GET REQUIRED MODIFIERS
app.post('/retell/function/get_required_modifiers', (req, res) => {
  const { a } = args(req);
  const item = MENU.find(i => i.id===a.item_id || i.key===a.item_id);
  if (!item) return send(res, 'Item not found.');
  const groups = item.mods.map(k => {
    const m = MODIFIERS[k]; if(!m) return null;
    return {group_id:k,name:k,question:m.q,options:m.opts.map(o=>({id:o,name:o}))};
  }).filter(Boolean);
  send(res, {item:item.name,modifier_groups:groups});
});

// 4. ADD TO CART
app.post('/retell/function/add_to_cart', (req, res) => {
  const { a, cid } = args(req);
  const cart = getCart(cid);
  const item = MENU.find(i => i.id===a.item_id || i.key===a.item_id);
  const ci = {
    item_id:a.item_id, name:item?item.name:`Item ${a.item_id}`, size:a.size||(item?item.size:''),
    price:item?item.price:0, qty:a.quantity||1, mods:a.modifiers||[], notes:a.special_instructions||'',
    cat:item?item.cat:'other', pc:item?item.pc:0
  };
  cart.items.push(ci);
  const tot = cart.items.reduce((s,i)=>s+i.price*i.qty,0);
  send(res, `Added ${ci.qty}x ${ci.name} to order. ${cart.items.length} item(s), ~$${tot.toFixed(2)} subtotal.`);
});

// 5. GET CART
app.post('/retell/function/get_cart', (req, res) => {
  const { a, cid } = args(req);
  const cart = getCart(cid);
  if (a.order_type) cart.order_type = a.order_type;
  const sub = cart.items.reduce((s,i)=>s+i.price*i.qty,0);
  const tax = Math.round(sub*CONFIG.tax*100)/100;
  const df = (cart.order_type==='delivery')?CONFIG.delivery.fee:0;
  send(res, {
    items:cart.items.map((i,idx)=>({index:idx,...i})),
    count:cart.items.length, subtotal:sub.toFixed(2), tax:tax.toFixed(2),
    delivery_fee:df.toFixed(2), total:(sub+tax+df).toFixed(2),
    summary: cart.items.map((i,idx)=>`${idx}:${i.qty}x ${i.name} $${i.price.toFixed(2)}${i.notes?' ['+i.notes+']':''}`).join(' | ') || 'Cart empty.'
  });
});

// 6. REMOVE FROM CART
app.post('/retell/function/remove_from_cart', (req, res) => {
  const { a, cid } = args(req);
  const cart = getCart(cid);
  const idx = a.cart_item_index;
  if (idx >= 0 && idx < cart.items.length) {
    const rm = cart.items.splice(idx,1)[0];
    return send(res, `Removed ${rm.name}. ${cart.items.length} item(s) left.`);
  }
  send(res, 'Item not found in cart.');
});

// 7. CHECK COMBO DEALS
app.post('/retell/function/check_combo_deals', (req, res) => {
  const { a } = args(req);
  const ci = a.cart_items || [];
  const ot = a.order_type || 'pickup';
  const combos = [], near = [];

  const has = (cat, opts) => ci.some(i => {
    if (i.category !== cat) return false;
    if (opts.size && String(i.size).replace(/"/g,'') !== String(opts.size).replace(/"/g,'')) return false;
    if (opts.pc && i.piece_count !== opts.pc) return false;
    return true;
  });
  const count = (cat, opts) => ci.filter(i => {
    if (i.category !== cat) return false;
    if (opts && opts.size && String(i.size).replace(/"/g,'') !== String(opts.size).replace(/"/g,'')) return false;
    return true;
  }).length;
  const indivTotal = ci.reduce((s,i)=>s+(i.price||0),0);

  // Family Deal 14": 14" pizza + 10 wings + 2L soda
  if (has('pizza',{size:'14'}) && has('buffalo_wings',{pc:10}) && has('soda',{size:'2liter'}))
    combos.push({name:"Family Deal (14\")",price:26.99,savings:Math.round((indivTotal-26.99)*100)/100});
  else if (has('pizza',{size:'16'}) && has('buffalo_wings',{pc:10}) && has('soda',{size:'2liter'}))
    combos.push({name:"Family Deal (16\")",price:27.99,savings:Math.round((indivTotal-27.99)*100)/100});
  // Pizza+Wings 12"
  else if (has('pizza',{size:'12'}) && has('buffalo_wings',{pc:10}) && has('soda',{size:'2liter'}))
    combos.push({name:"Pizza & Wings Deal",price:25.99,savings:Math.round((indivTotal-25.99)*100)/100});
  // Combo Deal: 12" + sub + 6wg + 2 cans
  else if (has('pizza',{size:'12'}) && has('sub',{size:'8'}) && has('buffalo_wings',{pc:6}) && count('soda')>=2)
    combos.push({name:"Combo Deal (12\")",price:29.99,savings:Math.round((indivTotal-29.99)*100)/100});
  else if (has('pizza',{size:'14'}) && has('sub',{size:'8'}) && has('buffalo_wings',{pc:8}) && count('soda')>=2)
    combos.push({name:"Combo Deal (14\")",price:33.99,savings:Math.round((indivTotal-33.99)*100)/100});
  // Pizza+Sub combo
  else if (has('pizza',{size:'12'}) && has('sub',{size:'8'}) && count('soda')>=1)
    combos.push({name:"Pizza & Sub Combo (12\")",price:22.99,savings:Math.round((indivTotal-22.99)*100)/100});
  else if (has('pizza',{size:'14'}) && has('sub',{size:'8'}) && count('soda')>=1)
    combos.push({name:"Pizza & Sub Combo (14\")",price:24.99,savings:Math.round((indivTotal-24.99)*100)/100});
  // Double Deal
  else if (count('pizza',{size:'14'})>=2)
    combos.push({name:"Double Deal (2x14\")",price:21.99,savings:Math.round((indivTotal-21.99)*100)/100});
  else if (count('pizza',{size:'12'})>=2)
    combos.push({name:"Double Deal (2x12\")",price:19.99,savings:Math.round((indivTotal-19.99)*100)/100});
  else if (count('pizza',{size:'16'})>=2)
    combos.push({name:"Double Deal (2x16\")",price:24.99,savings:Math.round((indivTotal-24.99)*100)/100});
  // Wings+Sub
  else if (has('sub',{size:'8'}) && has('buffalo_wings',{pc:6}) && count('soda')>=1)
    combos.push({name:"Wings & Sub Deal",price:17.99,savings:Math.round((indivTotal-17.99)*100)/100});
  // Sub Deal
  else if (has('sub',{size:'8'}) && count('soda')>=1)
    combos.push({name:"Sub Deal",price:11.99,savings:Math.round((indivTotal-11.99)*100)/100});
  // Wings Special
  else if (has('buffalo_wings',{pc:6}) && count('soda')>=1)
    combos.push({name:"Wings Special (6pc)",price:9.49,savings:Math.round((indivTotal-9.49)*100)/100});
  // Burger combo
  else if (has('sandwich',{}) && count('soda')>=1)
    combos.push({name:"Burger Combo",price:7.99,savings:Math.round((indivTotal-7.99)*100)/100});

  // Near misses
  if (!combos.length) {
    if (has('pizza',{size:'14'}) && has('buffalo_wings',{pc:10}) && !has('soda',{size:'2liter'}))
      near.push({name:"Family Deal (14\")",price:26.99,missing:"a 2-liter soda"});
    else if (has('pizza',{size:'14'}) && !has('buffalo_wings',{}) && has('soda',{size:'2liter'}))
      near.push({name:"Family Deal (14\")",price:26.99,missing:"10 buffalo wings"});
    else if (has('sub',{size:'8'}) && !has('soda',{}))
      near.push({name:"Sub Deal",price:11.99,missing:"a can of soda"});
    else if (has('buffalo_wings',{pc:6}) && !has('soda',{}))
      near.push({name:"Wings Special",price:9.49,missing:"a can of soda"});
    else if (has('sandwich',{}) && !has('soda',{}))
      near.push({name:"Burger Combo",price:7.99,missing:"a can of soda"});
  }

  // Pickup specials
  if (ot==='pickup' && !combos.length) {
    if (count('pizza',{size:'14'})===1 && ci.filter(i=>i.category==='pizza').length===1)
      combos.push({name:"Pickup Special (14\" cheese)",price:9.99,savings:Math.round((11.99-9.99)*100)/100});
    else if (count('pizza',{size:'12'})===1 && ci.filter(i=>i.category==='pizza').length===1)
      combos.push({name:"Pickup Special (12\" cheese)",price:8.99,savings:Math.round((10.99-8.99)*100)/100});
  }

  send(res, {combos_matched:combos, near_misses:near.slice(0,2)});
});

// 8. CALCULATE TOTAL
app.post('/retell/function/calculate_total', (req, res) => {
  const { a, cid } = args(req);
  const cart = getCart(cid);
  const ot = a.order_type || cart.order_type || 'pickup';
  const sub = cart.items.reduce((s,i)=>s+i.price*i.qty,0);
  const tax = Math.round(sub*CONFIG.tax*100)/100;
  const df = ot==='delivery'?CONFIG.delivery.fee:0;
  send(res, {subtotal:sub.toFixed(2),tax:tax.toFixed(2),delivery_fee:df.toFixed(2),total:(sub+tax+df).toFixed(2),
    item_count:cart.items.length,below_min:ot==='delivery'&&sub<CONFIG.delivery.min});
});

// 9. SUGGEST UPSELL
app.post('/retell/function/suggest_upsell', (req, res) => { send(res,'Logged.'); });

// 10. CHECK STORE HOURS
app.post('/retell/function/check_store_hours', (req, res) => {
  const h = new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false});
  const [hr,mn] = h.split(':').map(Number);
  const mins = hr*60+mn;
  send(res, {is_open:mins>=660&&mins<1320, hours:"11AM-10PM daily"});
});

// 11. VERIFY ADDRESS
app.post('/retell/function/verify_address', async (req, res) => {
  const { a } = args(req);
  if (!CONFIG.gmaps) return send(res, {valid:true,in_range:true,formatted_address:a.raw_address,note:'No geocoding key.'});
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/geocode/json',{params:{address:a.raw_address,key:CONFIG.gmaps},timeout:5000});
    if (r.data.status!=='OK') return send(res,{valid:false,error:'Could not verify address.'});
    const loc = r.data.results[0].geometry.location;
    const d = haversine(CONFIG.lat,CONFIG.lng,loc.lat,loc.lng);
    send(res,{valid:true,in_range:d<=CONFIG.delivery.maxMiles,formatted_address:r.data.results[0].formatted_address,distance:Math.round(d*10)/10});
  } catch(e) { send(res,{valid:true,in_range:true,formatted_address:a.raw_address,note:'Verification unavailable.'}); }
});

// 12. SUBMIT ORDER
app.post('/retell/function/submit_order', async (req, res) => {
  const { a, cid } = args(req);
  const cart = getCart(cid);
  const ot = a.order_type||'pickup';
  const sub = cart.items.reduce((s,i)=>s+i.price*i.qty,0);
  const tax = Math.round(sub*CONFIG.tax*100)/100;
  const df = ot==='delivery'?CONFIG.delivery.fee:0;
  const tot = (sub+tax+df).toFixed(2);
  const ref = Date.now()%2147483647;
  const ts = new Date().toLocaleString('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).replace(',','');
  const ph = (a.customer_phone||'0000000000').replace(/\D/g,'');

  let itemsXml = '';
  for (const i of cart.items) {
    itemsXml += `<OrderLineItem><itemName>${esc(i.name)}</itemName><foodMenuItemId>${i.item_id}</foodMenuItemId><quantity>${i.qty}</quantity><unitPrice>${i.price.toFixed(2)}</unitPrice><printKitchen>Y</printKitchen>${i.notes?`<additionalRequirements>${esc(i.notes)}</additionalRequirements>`:''}</OrderLineItem>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?><FoodOrder><referenceNumber>${ref}</referenceNumber><timeString>${ts}</timeString><type>${ot==='delivery'?'Delivery':'Pick-Up'}</type><comments>${esc(a.special_instructions||'')}</comments><payment>CASH</payment><subtotal>${sub.toFixed(2)}</subtotal><tax>${tax.toFixed(2)}</tax><total>${tot}</total>${ot==='delivery'?`<deliveryCharge>${df.toFixed(2)}</deliveryCharge>`:''}<brandName>${esc(CONFIG.name)}</brandName><Customer><firstName>${esc(a.customer_name||'Phone')}</firstName><lastName>Order</lastName><phoneAreaCode>${ph.slice(0,3)}</phoneAreaCode><phone>${ph.slice(3)}</phone><email>phone@order.com</email></Customer>${ot==='delivery'&&a.delivery_address?`<Address><addressLine1>${esc(a.delivery_address)}</addressLine1></Address>`:''}<Items>${itemsXml}</Items></FoodOrder>`;

  try {
    const r = await axios.post(CONFIG.pos.endpoint,xml,{params:{id:CONFIG.pos.id,password:CONFIG.pos.pw},headers:{'Content-Type':'application/xml'},timeout:12000});
    delete carts[cid];
    const eta = ot==='delivery'?'30 to 45 minutes':'15 to 20 minutes';
    send(res, `Order placed! Reference #${ref}. Total $${tot}. Ready in about ${eta}.`);
  } catch(e) {
    console.error('POS error:', e.message);
    send(res, 'Order submission failed. Please transfer caller to staff.');
  }
});

function haversine(a,b,c,d){const R=3959,dL=r(c-a),dN=r(d-b),x=Math.sin(dL/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dN/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function r(d){return d*Math.PI/180;}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

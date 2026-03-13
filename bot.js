const axios = require('axios');

// ============== CONFIG ==============
const CONFIG = {
  apiKey: '9qj9UqShLM9Fw69oxXLKGAECBVnVOHHXUxI6WN3KLCPVewzZb5lPZKS8HR1yLieP',
  secretKey: 'mHEPUX58PyJ1nMq7PVji3AVF8D1h58mBivENI50Di6xqv79Ecz5eHTs5JoFVblKW',
  testnet: true, // START WITH TESTNET!
  symbol: 'BTCUSDT',
  leverage: 10,
  // Risk management
  maxPositionSize: 0.01, // BTC
  maxLossPerTrade: 2, // % of account
  dailyLossLimit: 5, // % of account
  // Trading parameters
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  emaFast: 9,
  emaSlow: 21
};

const BASE_URL = CONFIG.testnet 
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

// ============== STATE ==============
let trades = [];
let dailyLoss = 0;
let lastTradeTime = 0;
let position = null;

// ============== HELPERS ==============
function sign(queryString) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', CONFIG.secretKey)
    .update(queryString)
    .digest('hex');
}

async function apiCall(endpoint, method = 'GET', params = {}) {
  const queryString = new URLSearchParams(params).toString();
  const signature = sign(queryString);
  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;
  
  try {
    const response = await axios({
      method,
      url,
      headers: { 'X-MBX-APIKEY': CONFIG.apiKey }
    });
    return response.data;
  } catch (error) {
    console.log('API Error:', error.response?.data || error.message);
    return null;
  }
}

// ============== INDICATORS ==============
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / (avgLoss || 0.0001);
  return 100 - (100 / (1 + rs));
}

function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

// ============== TRADING LOGIC ==============
async function getMarketData() {
  const candles = await apiCall('/fapi/v1/klines', 'GET', {
    symbol: CONFIG.symbol,
    interval: '15m',
    limit: 100
  });
  
  const closes = candles.map(c => parseFloat(c[4]));
  const currentPrice = closes[closes.length - 1];
  
  return {
    price: currentPrice,
    rsi: calculateRSI(closes, CONFIG.rsiPeriod),
    emaFast: calculateEMA(closes, CONFIG.emaFast),
    emaSlow: calculateEMA(closes, CONFIG.emaSlow),
    closes
  };
}

async function getBalance() {
  const account = await apiCall('/fapi/v2/account', 'GET', {});
  const btcBalance = account.assets.find(a => a.asset === 'BTC');
  return parseFloat(btcBalance.availableBalance);
}

async function getPosition() {
  const positions = await apiCall('/fapi/v2/positionRisk', 'GET', {
    symbol: CONFIG.symbol
  });
  const pos = positions.find(p => p.symbol === CONFIG.symbol && parseFloat(p.positionAmt) !== 0);
  return pos ? {
    amount: Math.abs(parseFloat(pos.positionAmt)),
    entryPrice: parseFloat(pos.entryPrice),
    side: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
    unrealizedPL: parseFloat(pos.unrealizedProfit)
  } : null;
}

async function openPosition(side, amount) {
  const sideMap = { LONG: 'BUY', SHORT: 'SELL' };
  const oppositeMap = { LONG: 'SELL', SHORT: 'BUY' };
  
  console.log(`\n🚀 OPENING ${side} POSITION: ${amount} BTC`);
  
  // Open position
  const order = await apiCall('/fapi/v1/order', 'POST', {
    symbol: CONFIG.symbol,
    side: sideMap[side],
    type: 'MARKET',
    quantity: amount,
    leverage: CONFIG.leverage
  });
  
  // Set stop loss
  const entryPrice = parseFloat(order.price);
  const stopLossPercent = 2; // 2% stop loss
  const stopPrice = side === 'LONG' 
    ? entryPrice * (1 - stopLossPercent / 100)
    : entryPrice * (1 + stopLossPercent / 100);
  
  await apiCall('/fapi/v1/order', 'POST', {
    symbol: CONFIG.symbol,
    side: oppositeMap[side],
    type: 'STOP_MARKET',
    quantity: amount,
    stopPrice: stopPrice,
    workingType: 'MARK_PRICE'
  });
  
  // Set take profit (2:1 risk reward)
  const takeProfitPrice = side === 'LONG'
    ? entryPrice * (1 + stopLossPercent * 2 / 100)
    : entryPrice * (1 - stopLossPercent * 2 / 100);
    
  await apiCall('/fapi/v1/order', 'POST', {
    symbol: CONFIG.symbol,
    side: oppositeMap[side],
    type: 'TAKE_PROFIT_MARKET',
    quantity: amount,
    stopPrice: takeProfitPrice,
    workingType: 'MARK_PRICE'
  });
  
  const trade = {
    id: order.orderId,
    side,
    amount,
    entryPrice,
    entryTime: Date.now(),
    status: 'OPEN'
  };
  
  trades.push(trade);
  saveLogs();
  
  return trade;
}

async function closePosition(position) {
  const sideMap = { LONG: 'SELL', SHORT: 'BUY' };
  
  console.log(`\n🔴 CLOSING ${position.side} POSITION`);
  
  await apiCall('/fapi/v1/order', 'POST', {
    symbol: CONFIG.symbol,
    side: sideMap[position.side],
    type: 'MARKET',
    quantity: position.amount
  });
  
  const closedTrade = trades.find(t => t.status === 'OPEN');
  if (closedTrade) {
    closedTrade.status = 'CLOSED';
    closedTrade.closeTime = Date.now();
    closedTrade.exitPrice = position.entryPrice; // Will update with actual
    saveLogs();
  }
  
  return true;
}

// ============== STRATEGY ==============
async function runStrategy() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 RUNNING STRATEGY - ${new Date().toLocaleString()}`);
  console.log('='.repeat(50));
  
  const market = await getMarketData();
  const balance = await getBalance();
  const currentPosition = await getPosition();
  
  console.log(`💰 Balance: ${balance.toFixed(4)} BTC`);
  console.log(`💵 Price: $${market.price.toLocaleString()}`);
  console.log(`📈 RSI: ${market.rsi.toFixed(2)}`);
  console.log(`📊 EMA Fast: ${market.emaFast.toFixed(2)} | EMA Slow: ${market.emaSlow.toFixed(2)}`);
  
  if (currentPosition) {
    console.log(`📍 Current Position: ${currentPosition.side} ${currentPosition.amount} BTC @ $${currentPosition.entryPrice.toLocaleString()}`);
    console.log(`💸 P&L: $${currentPosition.unrealizedPL.toFixed(2)}`);
  } else {
    console.log(`📍 No open position`);
  }
  
  // Trading logic
  if (currentPosition) {
    // Check if we should close
    const pnlPercent = (currentPosition.unrealizedPL / (currentPosition.amount * currentPosition.entryPrice)) * 100;
    
    if (Math.abs(pnlPercent) >= CONFIG.maxLossPerTrade) {
      console.log(`⚠️ Stop loss triggered! P&L: ${pnlPercent.toFixed(2)}%`);
      await closePosition(currentPosition);
    }
  } else {
    // Entry signals
    const rsi = market.rsi;
    const emaCross = market.emaFast > market.emaSlow;
    const rsiOversold = rsi < CONFIG.rsiOversold;
    const rsiOverbought = rsi > CONFIG.rsiOverbought;
    
    // Long signal: RSI oversold + EMA bullish
    if (rsiOversold && emaCross) {
      console.log(`🟢 LONG SIGNAL DETECTED! RSI: ${rsi.toFixed(2)}`);
      await openPosition('LONG', CONFIG.maxPositionSize);
    }
    // Short signal: RSI overbought + EMA bearish  
    else if (rsiOverbought && !emaCross) {
      console.log(`🔴 SHORT SIGNAL DETECTED! RSI: ${rsi.toFixed(2)}`);
      await openPosition('SHORT', CONFIG.maxPositionSize);
    } else {
      console.log(`⏳ No signal. Waiting...`);
    }
  }
  
  console.log('');
}

// ============== LOGGING ==============
function saveLogs() {
  const log = {
    timestamp: new Date().toISOString(),
    balance: getBalance(),
    openPosition: position,
    trades: trades.slice(-10)
  };
  
  const fs = require('fs');
  fs.writeFileSync('/data/workspace/trading-bot/logs.json', JSON.stringify(log, null, 2));
}

// ============== MAIN LOOP ==============
async function main() {
  console.log('🤖 TRADING BOT STARTED');
  console.log(`📍 Mode: ${CONFIG.testnet ? 'TESTNET' : 'LIVE'}`);
  console.log(`🪙 Trading: ${CONFIG.symbol}`);
  console.log(`⚖️ Leverage: ${CONFIG.leverage}x`);
  
  // Set leverage
  await apiCall('/fapi/v1/leverage', 'POST', {
    symbol: CONFIG.symbol,
    leverage: CONFIG.leverage
  });
  
  // Run immediately then every 15 minutes
  runStrategy();
  setInterval(runStrategy, 15 * 60 * 1000);
}

main().catch(console.error);

const axios = require('axios');

// ============== CONFIG ==============
const CONFIG = {
  apiKey: '9qj9UqShLM9Fw69oxXLKGAECBVnVOHHXUxI6WN3KLCPVewzZb5lPZKS8HR1yLieP',
  secretKey: 'mHEPUX58PyJ1nMq7PVji3AVF8D1h58mBivENI50Di6xqv79Ecz5eHTs5JoFVblKW',
  testnet: true,
  symbol: 'BTCUSDT',
  leverage: 10,
  // Risk management
  maxPositionSize: 0.01,
  maxLossPerTrade: 2,
  dailyLossLimit: 5,
  // RSI-only strategy
  rsiPeriod: 14,
  rsiOversold: 35,
  rsiOverbought: 65,
  rsiExit: 50
};

const BASE_URL = CONFIG.testnet 
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

// ============== STATE ==============
let trades = [];
let dailyLoss = 0;
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
  
  const entryPrice = parseFloat(order.price);
  
  // Set stop loss (2%)
  const stopLossPercent = 2;
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
  
  // Set take profit (4% = 2:1)
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
    saveLogs();
  }
  
  return true;
}

// ============== STRATEGY (RSI-ONLY) ==============
async function runStrategy() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 RUNNING RSI-ONLY STRATEGY - ${new Date().toLocaleString()}`);
  console.log('='.repeat(50));
  
  const market = await getMarketData();
  const balance = await getBalance();
  const currentPosition = await getPosition();
  
  console.log(`💰 Balance: ${balance.toFixed(4)} BTC`);
  console.log(`💵 Price: $${market.price.toLocaleString()}`);
  console.log(`📈 RSI: ${market.rsi.toFixed(2)} (Long < ${CONFIG.rsiOversold}, Short > ${CONFIG.rsiOverbought})`);
  
  if (currentPosition) {
    console.log(`📍 Position: ${currentPosition.side} ${currentPosition.amount} BTC @ $${currentPosition.entryPrice.toLocaleString()}`);
    console.log(`💸 P&L: $${currentPosition.unrealizedPL.toFixed(2)}`);
  } else {
    console.log(`📍 No open position`);
  }
  
  // Trading logic
  if (currentPosition) {
    // Check exit conditions
    const shouldExit = 
      (currentPosition.side === 'LONG' && market.rsi > CONFIG.rsiExit) ||
      (currentPosition.side === 'SHORT' && market.rsi < CONFIG.rsiExit);
    
    // Check stop loss
    const pnlPercent = (currentPosition.unrealizedPL / (currentPosition.amount * currentPosition.entryPrice)) * 100;
    
    if (Math.abs(pnlPercent) >= CONFIG.maxLossPerTrade) {
      console.log(`⚠️ Stop loss triggered! P&L: ${pnlPercent.toFixed(2)}%`);
      await closePosition(currentPosition);
    } else if (shouldExit) {
      console.log(`🎯 RSI exit signal (RSI: ${market.rsi.toFixed(2)} at neutral ${CONFIG.rsiExit})`);
      await closePosition(currentPosition);
    } else {
      console.log(`⏳ Holding position... RSI: ${market.rsi.toFixed(2)}`);
    }
  } else {
    // Entry signals - RSI only
    if (market.rsi < CONFIG.rsiOversold) {
      console.log(`🟢 LONG SIGNAL! RSI: ${market.rsi.toFixed(2)} (below ${CONFIG.rsiOversold})`);
      await openPosition('LONG', CONFIG.maxPositionSize);
    } else if (market.rsi > CONFIG.rsiOverbought) {
      console.log(`🔴 SHORT SIGNAL! RSI: ${market.rsi.toFixed(2)} (above ${CONFIG.rsiOverbought})`);
      await openPosition('SHORT', CONFIG.maxPositionSize);
    } else {
      console.log(`⏳ No signal. RSI at ${market.rsi.toFixed(2)} - waiting for ${CONFIG.rsiOversold} or ${CONFIG.rsiOverbought}`);
    }
  }
  
  console.log('');
}

// ============== LOGGING ==============
function saveLogs() {
  const log = {
    timestamp: new Date().toISOString(),
    trades: trades.slice(-20)
  };
  
  const fs = require('fs');
  fs.writeFileSync('/data/workspace/trading-bot/logs.json', JSON.stringify(log, null, 2));
}

// ============== MAIN LOOP ==============
async function main() {
  console.log('🤖 KNOX TRADING BOT STARTED');
  console.log(`📍 Mode: ${CONFIG.testnet ? 'TESTNET' : 'LIVE'}`);
  console.log(`🪙 Trading: ${CONFIG.symbol}`);
  console.log(`⚖️ Leverage: ${CONFIG.leverage}x`);
  console.log(`📈 Strategy: RSI-Only (${CONFIG.rsiOversold}/${CONFIG.rsiOverbought})`);
  
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

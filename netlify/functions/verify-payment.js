const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RECEIVING_ADDRESSES = {
  bsc: process.env.BSC_RECEIVING_ADDRESS?.toLowerCase(),
  tron: process.env.TRON_RECEIVING_ADDRESS,
};

const PLAN_AMOUNTS = { monthly: 9, yearly: 99 };

const requestLog = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 60000;
  const requests = requestLog.get(ip) || [];
  const recentRequests = requests.filter(t => t > windowStart);
  if (recentRequests.length > 10) return false;
  recentRequests.push(now);
  requestLog.set(ip, recentRequests);
  return true;
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(clientIP)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  try {
    const { txHash, network, plan, userId } = JSON.parse(event.body);
    
    if (!txHash || !network || !plan || !userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing parameters' }) };
    }
    
    if (!['bsc', 'tron'].includes(network)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid network' }) };
    }
    
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('tx_hash', txHash)
      .maybeSingle();
    
    if (existing) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Transaction already used' }) };
    }
    
    let txData;
    if (network === 'bsc') {
      txData = await verifyBSC(txHash);
    } else {
      txData = await verifyTRON(txHash);
    }
    
    if (!txData.success) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: txData.error }) };
    }
    
    const expectedAddress = RECEIVING_ADDRESSES[network];
    if (txData.toAddress !== expectedAddress) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Transaction not sent to your address' }) };
    }
    
    const expectedAmount = PLAN_AMOUNTS[plan];
    const tolerance = 0.005;
    
    if (txData.amount < expectedAmount * (1 - tolerance)) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ 
          error: `Amount insufficient. Expected: ${expectedAmount} USDT, Received: ${txData.amount.toFixed(6)} USDT` 
        }) 
      };
    }
    
    if (!txData.isSuccess) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Transaction failed or pending' }) };
    }
    
    const requiredConfirmations = network === 'bsc' ? 12 : 19;
    if (txData.confirmations < requiredConfirmations) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ 
          error: `Waiting for confirmations. Current: ${txData.confirmations}, Required: ${requiredConfirmations}` 
        }) 
      };
    }
    
    const txAge = Date.now() - txData.timestamp;
    const maxAge = 24 * 60 * 60 * 1000;
    
    if (txAge > maxAge) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Transaction too old' }) };
    }
    
    const periodDays = plan === 'yearly' ? 365 : 30;
    
    const { data: subscription, error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan: plan,
        status: 'active',
        tx_hash: txHash,
        network: network,
        amount_received: txData.amount,
        sender_address: txData.fromAddress,
        block_number: txData.blockNumber,
        confirmations: txData.confirmations,
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000),
        verified_at: new Date(),
        verification_method: 'auto',
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Insert error:', insertError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database error' }) };
    }
    
    await sendNotification(userId, plan, txData.amount);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        subscription: subscription, 
        message: 'Payment verified and subscription activated!' 
      }),
    };

  } catch (error) {
    console.error('Verification error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

async function verifyBSC(txHash) {
  try {
    const [receiptRes, txRes, blockRes] = await Promise.all([
      fetch(`https://api.bscscan.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.BSCSCAN_API_KEY}`),
      fetch(`https://api.bscscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${process.env.BSCSCAN_API_KEY}`),
      fetch(`https://api.bscscan.com/api?module=proxy&action=eth_blockNumber&apikey=${process.env.BSCSCAN_API_KEY}`)
    ]);
    
    const receiptData = await receiptRes.json();
    const txData = await txRes.json();
    const blockData = await blockRes.json();
    
    if (receiptData.error || !receiptData.result) {
      return { success: false, error: 'Transaction not found' };
    }
    
    const receipt = receiptData.result;
    const tx = txData.result;
    const latestBlock = parseInt(blockData.result, 16);
    const txBlock = parseInt(receipt.blockNumber, 16);
    const confirmations = latestBlock - txBlock + 1;
    
    const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase();
    
    let toAddress, fromAddress, amount;
    
    if (tx.to.toLowerCase() === USDT_CONTRACT) {
      const input = tx.input;
      toAddress = '0x' + input.slice(34, 74).toLowerCase();
      fromAddress = tx.from.toLowerCase();
      const amountHex = input.slice(74);
      amount = parseInt(amountHex, 16) / 1e18;
    } else {
      toAddress = tx.to.toLowerCase();
      fromAddress = tx.from.toLowerCase();
      amount = parseInt(tx.value, 16) / 1e18;
    }
    
    const timestamp = Date.now() - (confirmations * 3000);
    
    return {
      success: true,
      toAddress,
      fromAddress,
      amount,
      blockNumber: txBlock,
      confirmations,
      isSuccess: receipt.status === '0x1',
      timestamp,
    };
    
  } catch (error) {
    console.error('BSC verification error:', error);
    return { success: false, error: error.message };
  }
}

async function verifyTRON(txHash) {
  try {
    const response = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash}`);
    const data = await response.json();
    
    if (!data) {
      return { success: false, error: 'Transaction not found' };
    }
    
    if (data.ret?.[0]?.contractRet !== 'SUCCESS') {
      return { success: false, error: 'Transaction failed' };
    }
    
    const triggerInfo = data.trigger_info;
    if (!triggerInfo || triggerInfo.methodName !== 'transfer') {
      return { success: false, error: 'Not a USDT transfer' };
    }
    
    const parameterMap = triggerInfo.parameterMap;
    const amount = parameterMap._value / 1e6;
    const confirmations = data.confirmations || 0;
    
    return {
      success: true,
      toAddress: parameterMap._to,
      fromAddress: data.ownerAddress,
      amount,
      blockNumber: data.block,
      confirmations,
      isSuccess: data.ret[0].contractRet === 'SUCCESS',
      timestamp: data.timestamp,
    };
    
  } catch (error) {
    console.error('TRON verification error:', error);
    return { success: false, error: error.message };
  }
}

async function sendNotification(userId, plan, amount) {
  try {
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const message = `🎉 اشتراك جديد!\nالمستخدم: ${userId}\nالخطة: ${plan}\nالمبلغ: ${amount} USDT`;
      
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message,
        }),
      });
    }
  } catch (e) {
    console.error('Notification error:', e);
  }
}

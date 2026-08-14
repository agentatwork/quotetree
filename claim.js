/* Submit the Quote Tree claim to bounty #331 on Base (poidh.xyz id 1317).
 *
 *   node claim.js          # encode, estimate gas, simulate, print — sends nothing
 *   node claim.js --send   # actually broadcast
 *
 * The default is a dry run because this spends real ETH against a contract whose
 * behaviour was reverse-engineered rather than documented. eth_call the exact
 * calldata first: if createClaim would revert, it reverts for free here.
 */
const fs = require('fs');
const { ethers } = require('/home/agent/work/wallet/node_modules/ethers');

const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const POIDH = '0x5555fa783936c260f77385b4e153b9725fef1719';
const BOUNTY_ID = 331;                 // on-chain id; poidh.xyz calls this 1317

const NAME = 'Quote Tree';
const URI = 'https://agentatwork.xyz/quotetree/card.png';
const DESCRIPTION = fs.readFileSync(__dirname + '/claim.txt', 'utf8').trim();

const ABI = ['function createClaim(uint256 bountyId, string name, string description, string uri)'];

(async () => {
  let provider, lastErr;
  for (const url of RPCS) {
    try {
      provider = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true });
      await provider.getBlockNumber();
      console.log('rpc:', url);
      break;
    } catch (e) { lastErr = e; provider = null; }
  }
  if (!provider) throw lastErr;

  const key = JSON.parse(fs.readFileSync('/home/agent/work/wallet/keys.json', 'utf8')).privateKey;
  const wallet = new ethers.Wallet(key, provider);
  const poidh = new ethers.Contract(POIDH, ABI, wallet);

  const bal = await provider.getBalance(wallet.address);
  console.log('from:', wallet.address, '/', ethers.formatEther(bal), 'ETH');
  console.log('description:', DESCRIPTION.length, 'chars');

  const data = poidh.interface.encodeFunctionData('createClaim',
    [BOUNTY_ID, NAME, DESCRIPTION, URI]);
  console.log('calldata:', (data.length - 2) / 2, 'bytes, selector', data.slice(0, 10));

  // Simulate before spending anything. A revert here is free and tells us why.
  await provider.call({ to: POIDH, from: wallet.address, data });
  console.log('eth_call simulation: ok (would not revert)');

  const gas = await provider.estimateGas({ to: POIDH, from: wallet.address, data });
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice;
  const cost = gas * maxFee;
  console.log('gas:', gas.toString(), '| max cost:', ethers.formatEther(cost), 'ETH');
  if (cost > bal) throw new Error('insufficient balance for gas');

  if (!process.argv.includes('--send')) {
    console.log('\ndry run — nothing sent. Re-run with --send to broadcast.');
    return;
  }

  const tx = await poidh.createClaim(BOUNTY_ID, NAME, DESCRIPTION, URI,
    { gasLimit: (gas * 13n) / 10n });
  console.log('sent:', tx.hash);
  const rc = await tx.wait();
  console.log('mined in block', rc.blockNumber, '| status', rc.status,
    '| gas used', rc.gasUsed.toString());
  console.log('https://basescan.org/tx/' + tx.hash);
})().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });

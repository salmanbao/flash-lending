const TradeExecutor = artifacts.require('TradeExecutor');
const Bank = artifacts.require('Bank');
const FlashLender = artifacts.require('FlashLender');
const Arbitrage = artifacts.require('Arbitrage');
const MockToken = artifacts.require('MockToken');
const chai = require('chai');
const expect = chai.expect;
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const Web3 = require('web3');
const web3Beta = new Web3(web3.currentProvider);

import { ZeroExUtils } from './helpers/ZeroExUtils';
import { EtherDeltaUtils } from './helpers/EtherDeltaUtils';
import { getTxCost } from './helpers/utils';
import { deployZeroEx } from './helpers/ZeroExUtils';
import { MAX_UINT } from './helpers/constants';
import BigNumber from 'bignumber.js';

contract('Arbitrage', accounts => {
  // Contracts
  let bank;
  let flashLender;
  let arbitrage;
  let token;
  let tradeExecutor;
  let tradeExecutorContract; // web3 version of trade executor (not truffle-contract)

  // 0x
  let zeroExUtils;
  let zeroExWrapper;
  let zeroExWrapperContract; // web3 version of wrapper (not truffle-contract)
  let zeroEx;
  let weth;
  let exchange;
  let tokenTransferProxy;

  let etherDeltaUtils;
  let etherDeltaWrapper;
  let etherDeltaWrapperContract; // web3 version of wrapper (not truffle-contract)
  let etherDelta;

  // Accounts
  const trader = accounts[1];
  const maker = accounts[2];
  const lender = accounts[3];
  const dest = accounts[4];

  // Constants
  const DEPOSIT_AMOUNT = 10000;
  const ETH = '0x0000000000000000000000000000000000000000';

  const FEE = 10 ** 15; // .1% fee (10 ** 15 / 10*18)
  const PROFIT = 2000;
  const TRADE_AMOUNT = 10000;

  beforeEach(async () => {
    const traderETHBefore = await web3Beta.eth.getBalance(trader);
    tradeExecutor = await TradeExecutor.new();
    bank = await Bank.new({ from: lender }); // lender is owner of the bank
    flashLender = await FlashLender.new(bank.address, FEE);
    arbitrage = await Arbitrage.new(flashLender.address, tradeExecutor.address);

    zeroExUtils = new ZeroExUtils(web3Beta);
    await zeroExUtils.init();

    ({
      zeroExWrapper,
      zeroExWrapperContract,
      exchange,
      weth,
      tokenTransferProxy,
      zeroEx
    } = zeroExUtils);

    etherDeltaUtils = new EtherDeltaUtils(web3Beta);
    await etherDeltaUtils.init();

    ({
      etherDeltaWrapper,
      etherDeltaWrapperContract,
      etherDelta
    } = etherDeltaUtils);

    // Approve the FlashLender contract as a bank borrower
    await bank.addBorrower(flashLender.address, { from: lender });

    // Lender deposits Ether into the bank
    await bank.deposit(ETH, DEPOSIT_AMOUNT, {
      from: lender,
      value: DEPOSIT_AMOUNT
    });

    await weth.deposit({
      from: maker,
      value: TRADE_AMOUNT
    });

    token = await MockToken.new([maker, lender], [TRADE_AMOUNT, TRADE_AMOUNT]);

    // Lender deposits tokens into the bank
    await bank.deposit(token.address, DEPOSIT_AMOUNT, { from: lender });

    // Approve the proxy to transfer tokens on behalf of the maker
    await weth.approve(tokenTransferProxy.address, MAX_UINT, {
      from: maker
    });

    await token.approve(tokenTransferProxy.address, MAX_UINT, {
      from: maker
    });

    tradeExecutorContract = new web3Beta.eth.Contract(
      tradeExecutor.abi,
      tradeExecutor.address
    );
  });

  it('flash lender should have the correct fee', async () => {
    const fee = await flashLender.fee();
    expect(fee.toNumber()).to.equal(FEE);
  });

  it('should calculate the repay amount correctly', async () => {
    const tradeAmount = 1000;
    const repayAmount = await arbitrage.getRepayAmount(tradeAmount);
    const feeAmount = (FEE * tradeAmount) / 10 ** 18;
    expect(repayAmount.toNumber()).to.equal(feeAmount + tradeAmount);
  });

  const zeroExEtherTradeData = async () => {
    const order1 = {
      exchange: exchange.address,
      maker: maker,
      makerToken: token.address,
      takerToken: weth.address,
      makerAmount: `${TRADE_AMOUNT}`,
      takerAmount: `${TRADE_AMOUNT - PROFIT}`
    };
    const trade1 = await zeroExUtils.getTokensOrderData(order1);
    const order2 = {
      exchange: exchange.address,
      maker: maker,
      makerToken: weth.address,
      takerToken: token.address,
      makerAmount: `${TRADE_AMOUNT}`,
      takerAmount: `${TRADE_AMOUNT}`
    };
    const trade2 = await zeroExUtils.getEtherOrderData(order2);
    const wrappers = [zeroExWrapper.address, zeroExWrapper.address];

    const data = tradeExecutorContract.methods
      .trade(wrappers, token.address, trade1, trade2)
      .encodeABI();
    return data;
  };

  it('should execute an arbitrage trade for Ether with two 0x orders', async () => {
    const bankETHBefore = await web3Beta.eth.getBalance(bank.address);
    const destETHBefore = await web3Beta.eth.getBalance(dest);

    const data = await zeroExEtherTradeData();
    await arbitrage.submitTrade(ETH, TRADE_AMOUNT, dest, data, {
      from: trader
    });

    const feeAmount = (FEE * TRADE_AMOUNT) / 10 ** 18;
    const destETHAfter = await web3Beta.eth.getBalance(dest);

    expect(destETHAfter.toString()).to.equal(
      BigNumber(destETHBefore)
        .plus(BigNumber(PROFIT))
        .minus(feeAmount)
        .toString()
    );
    const bankETHAfter = await web3Beta.eth.getBalance(bank.address);
    expect(bankETHAfter).to.equal(
      BigNumber(bankETHBefore)
        .plus(feeAmount)
        .toString()
    );
  });

  const zeroExTokenTradeData = async () => {
    const order1 = {
      exchange: exchange.address,
      maker: maker,
      makerToken: weth.address,
      takerToken: token.address,
      makerAmount: `${TRADE_AMOUNT}`,
      takerAmount: `${TRADE_AMOUNT - PROFIT}`
    };
    const trade1 = await zeroExUtils.getEtherOrderData(order1);
    const order2 = {
      exchange: exchange.address,
      maker: maker,
      makerToken: token.address,
      takerToken: weth.address,
      makerAmount: `${TRADE_AMOUNT}`,
      takerAmount: `${TRADE_AMOUNT}`
    };
    const trade2 = await zeroExUtils.getTokensOrderData(order2);
    const wrappers = [zeroExWrapper.address, zeroExWrapper.address];
    const data = tradeExecutorContract.methods
      .tradeForTokens(wrappers, token.address, trade1, trade2)
      .encodeABI();
    return data;
  };

  it('should execute an arbitrage trade for tokens with two 0x orders', async () => {
    const bankTokensBefore = await token.balanceOf(bank.address);
    const destTokensBefore = await token.balanceOf(dest);

    const borrowAmount = TRADE_AMOUNT - PROFIT;

    const data = await zeroExTokenTradeData();
    await arbitrage.submitTrade(token.address, borrowAmount, dest, data, {
      from: trader
    });

    const feeAmount = (FEE * borrowAmount) / 10 ** 18;
    const bankTokensAfter = await token.balanceOf(bank.address);
    const destTokensAfter = await token.balanceOf(dest);

    expect(bankTokensAfter.toString()).to.equal(
      BigNumber(bankTokensBefore)
        .plus(feeAmount)
        .toString()
    );
    expect(destTokensAfter.toString()).to.equal(
      BigNumber(destTokensBefore)
        .plus(BigNumber(PROFIT))
        .minus(feeAmount)
        .toString()
    );
  });

  const etherDeltaTradeData = async () => {
    const makerPrivateKey =
      '0xfd88f66d3c9a809a45b0116e2b314efad7cb73257e0f3259ea8da663459dfcdf';

    // Deposit tokens to EtherDelta
    await etherDelta.depositToken(token.address, TRADE_AMOUNT, { from: maker });

    const expires = 1546300800; // 1/1/2019

    const takerAmount1 = TRADE_AMOUNT - 1000;
    const makerAmount1 = TRADE_AMOUNT;

    const takerAmount2 = TRADE_AMOUNT;
    const makerAmount2 = TRADE_AMOUNT;

    const nonce1 = 1;
    const nonce2 = 2;

    // Place order for maker
    await etherDelta.order(
      0,
      takerAmount1,
      token.address,
      makerAmount1,
      expires,
      nonce1,
      {
        from: maker
      }
    );

    const sha256Hash1 = await etherDelta.hash(
      0,
      takerAmount1,
      token.address,
      makerAmount1,
      expires,
      nonce1
    );
    const ecSignature1 = web3Beta.eth.accounts.sign(
      sha256Hash1,
      makerPrivateKey
    );

    await etherDelta.deposit({
      from: maker,
      value: TRADE_AMOUNT
    });

    // Place order for maker
    await etherDelta.order(
      token.address,
      takerAmount2,
      0,
      makerAmount2,
      expires,
      nonce2,
      {
        from: maker
      }
    );

    const sha256Hash2 = await etherDelta.hash(
      token.address,
      takerAmount2,
      0,
      makerAmount2,
      expires,
      nonce2
    );

    const ecSignature2 = web3Beta.eth.accounts.sign(
      sha256Hash2,
      makerPrivateKey
    );

    const trade1 = etherDeltaWrapperContract.methods
      .getTokens(
        takerAmount1,
        token.address,
        makerAmount1,
        expires,
        nonce1,
        maker,
        ecSignature1.r,
        ecSignature1.s,
        ecSignature1.v
      )
      .encodeABI();

    const trade2 = etherDeltaWrapperContract.methods
      .getEther(
        token.address,
        takerAmount2,
        makerAmount2,
        expires,
        nonce2,
        maker,
        ecSignature2.r,
        ecSignature2.s,
        ecSignature2.v
      )
      .encodeABI();

    const wrappers = [etherDeltaWrapper.address, etherDeltaWrapper.address];
    const data = tradeExecutorContract.methods
      .trade(wrappers, token.address, trade1, trade2)
      .encodeABI();
    return data;
  };

  it('should execute an arbitrage trade for Ether with two EtherDelta orders', async () => {
    const destETHBefore = await web3Beta.eth.getBalance(dest);
    const bankETHBefore = await web3Beta.eth.getBalance(bank.address);

    const borrowAmount = TRADE_AMOUNT - 1000;

    const data = await etherDeltaTradeData();
    await arbitrage.submitTrade(ETH, borrowAmount, dest, data, {
      from: trader
    });

    const feeAmount = (FEE * borrowAmount) / 10 ** 18;
    const destETHAfter = await web3Beta.eth.getBalance(dest);

    expect(destETHAfter.toString()).to.equal(
      BigNumber(destETHBefore)
        .plus(BigNumber(1000))
        .minus(feeAmount)
        .toString()
    );
    const bankETHAfter = await web3Beta.eth.getBalance(bank.address);
    expect(bankETHAfter).to.equal(
      BigNumber(bankETHBefore)
        .plus(feeAmount)
        .toString()
    );
  });
});

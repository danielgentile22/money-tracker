import { test, expect } from 'vitest';
import type { Transaction, AccountBase, InvestmentTransaction } from 'plaid';
import { toCents, mapAccount, mapTransaction, mapInvestmentTxn } from './plaid-map';
import { ownerSignedBalance } from './sync';

// The Plaid money boundary (ADR-0009): the single float-dollars→integer-cents
// conversion, the owner-sign flip, and the liability negation. Pure functions,
// no client() (p9-35, p9-82).

test('toCents rounds to the nearest cent and passes null/undefined through', () => {
	expect(toCents(12.34)).toBe(1234);
	expect(toCents(0)).toBe(0);
	expect(toCents(19.999)).toBe(2000); // rounds up — a Math.trunc regression would give 1999
	expect(toCents(5.554)).toBe(555); // rounds down
	expect(toCents(null)).toBeNull();
	expect(toCents(undefined)).toBeNull();
});

test('ownerSignedBalance negates only liabilities', () => {
	expect(ownerSignedBalance('credit', 50_000)).toBe(-50_000);
	expect(ownerSignedBalance('loan', 120_000)).toBe(-120_000);
	expect(ownerSignedBalance('depository', 50_000)).toBe(50_000);
	expect(ownerSignedBalance('investment', 50_000)).toBe(50_000);
	expect(ownerSignedBalance('credit', null)).toBeNull();
});

test('mapAccount stores a credit-card balance negative', () => {
	const card = {
		account_id: 'c1',
		name: 'Card',
		type: 'credit',
		subtype: 'credit card',
		mask: '1234',
		balances: { current: 500.5, available: 100 }
	} as unknown as AccountBase;

	expect(mapAccount(card)).toEqual({
		account_id: 'c1',
		name: 'Card',
		type: 'credit',
		subtype: 'credit card',
		mask: '1234',
		current_balance_cents: -50_050, // owed, stored negative
		available_balance_cents: -10_000
	});
});

test('mapTransaction flips Plaid outflow-positive to owner outflow-negative', () => {
	const spend = {
		transaction_id: 't1',
		pending_transaction_id: 'p1',
		account_id: 'a1',
		date: '2026-07-01',
		name: 'COFFEE',
		merchant_name: 'Blue Bottle',
		amount: 4.5, // Plaid: positive = money out
		pending: false,
		personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'COFFEE', confidence_level: 'HIGH' },
		payment_channel: 'in store'
	} as unknown as Transaction;

	expect(mapTransaction(spend)).toEqual({
		transaction_id: 't1',
		pending_transaction_id: 'p1',
		account_id: 'a1',
		date: '2026-07-01',
		name: 'COFFEE',
		merchant_name: 'Blue Bottle',
		amount_cents: -450,
		pending: false,
		pfc_primary: 'FOOD_AND_DRINK',
		pfc_detailed: 'COFFEE',
		pfc_confidence: 'HIGH',
		payment_channel: 'in store'
	});

	// a refund: Plaid negative = money in → owner positive
	const refund = { ...spend, amount: -4.5 } as unknown as Transaction;
	expect(mapTransaction(refund).amount_cents).toBe(450);
});

// over is loosely typed: Plaid's type/subtype are string enums, so literals
// like 'transfer' aren't assignable to Partial<InvestmentTransaction>.
const inv = (over: Record<string, unknown>): InvestmentTransaction =>
	({
		investment_transaction_id: 'i1',
		account_id: 'a1',
		date: '2026-07-01',
		name: 'X',
		amount: 100,
		type: 'buy',
		subtype: 'buy',
		...over
	}) as unknown as InvestmentTransaction;

test('mapInvestmentTxn marks only boundary-crossing cash flows external', () => {
	// external = cash actually entering/leaving the account
	expect(mapInvestmentTxn(inv({ type: 'cash', subtype: 'contribution' })).internal).toBe(false);
	expect(mapInvestmentTxn(inv({ type: 'cash', subtype: 'deposit' })).internal).toBe(false);
	expect(mapInvestmentTxn(inv({ type: 'cash', subtype: 'withdrawal' })).internal).toBe(false);
	expect(mapInvestmentTxn(inv({ type: 'transfer', subtype: 'transfer' })).internal).toBe(false);

	// internal = invisible to spending semantics
	expect(mapInvestmentTxn(inv({ type: 'buy', subtype: 'buy' })).internal).toBe(true);
	expect(mapInvestmentTxn(inv({ type: 'cash', subtype: 'dividend' })).internal).toBe(true); // not on the whitelist

	// sign flip still applies
	expect(mapInvestmentTxn(inv({ amount: 250 })).amount_cents).toBe(-25_000);
});

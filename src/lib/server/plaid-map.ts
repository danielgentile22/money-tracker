import type { Transaction, AccountBase, InvestmentTransaction } from 'plaid';
import {
	ownerSignedBalance,
	type SourceAccount,
	type SourceTxn,
	type SourceInvestmentTxn
} from './sync';

// Pure Plaid→Source mappers, kept out of plaid.ts so they carry no db/client
// dependency and can be unit-tested directly (p9-35, p9-82). The owner-signed
// cents convention lives here: Plaid's positive-means-outflow becomes negative,
// and liabilities are negated by ownerSignedBalance.

/** The one place Plaid float dollars become ADR-0009 integer cents. */
export function toCents(amount: number | null | undefined): number | null {
	return amount == null ? null : Math.round(amount * 100);
}

export function mapAccount(a: AccountBase): SourceAccount {
	return {
		account_id: a.account_id,
		name: a.name,
		type: a.type,
		subtype: a.subtype ?? null,
		mask: a.mask ?? null,
		current_balance_cents: ownerSignedBalance(a.type, toCents(a.balances.current)),
		available_balance_cents: ownerSignedBalance(a.type, toCents(a.balances.available))
	};
}

export function mapTransaction(t: Transaction): SourceTxn {
	return {
		transaction_id: t.transaction_id,
		pending_transaction_id: t.pending_transaction_id ?? null,
		account_id: t.account_id,
		date: t.date,
		name: t.name,
		merchant_name: t.merchant_name ?? null,
		amount_cents: -(toCents(t.amount) ?? 0),
		pending: t.pending,
		pfc_primary: t.personal_finance_category?.primary ?? null,
		pfc_detailed: t.personal_finance_category?.detailed ?? null,
		pfc_confidence: t.personal_finance_category?.confidence_level ?? null,
		payment_channel: t.payment_channel ?? null
	};
}

export function mapInvestmentTxn(t: InvestmentTransaction): SourceInvestmentTxn {
	// external = cash actually crossing the account boundary; internal buys /
	// sells / dividends / fees are invisible to spending semantics.
	const external =
		t.type === 'transfer' ||
		(t.type === 'cash' && ['contribution', 'deposit', 'withdrawal'].includes(t.subtype ?? ''));
	return {
		investment_transaction_id: t.investment_transaction_id,
		account_id: t.account_id,
		date: t.date,
		name: t.name,
		amount_cents: -(toCents(t.amount) ?? 0),
		internal: !external
	};
}

/**
 * True when a removeConnection itemRemove failure means the Item/token is
 * already gone (safe to finish local teardown); false for anything transient
 * — network, 5xx, rate limit, locked Keychain — which must rethrow so the
 * access token survives for a retry (audit #26).
 */
export function itemAlreadyGone(e: unknown): boolean {
	const code = (e as { response?: { data?: { error_code?: string } } })?.response?.data
		?.error_code;
	if (code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN') return true;
	return e instanceof Error && e.message.startsWith('No access token in Keychain');
}

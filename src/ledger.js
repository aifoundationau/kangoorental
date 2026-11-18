import { brisbaneDate } from './util.js';

/** Extracts contractor and GST split configuration from site settings. */
export function ledgerConfig(settings = {}) {
  const shareA = Number(settings.contractor_a_share_pct ?? 50);
  const shareB = Number(settings.contractor_b_share_pct ?? 50);
  return {
    contractorA: {
      id: 'contractor_a',
      name: String(settings.contractor_a_name || 'David Robertson'),
      role: String(settings.contractor_a_role || 'Maintains booking system, Stripe payments, distributions'),
      sharePct: Number.isFinite(shareA) ? shareA : 50,
    },
    contractorB: {
      id: 'contractor_b',
      name: String(settings.contractor_b_name || 'Car Shop (TBD)'),
      role: String(settings.contractor_b_role || 'Maintains registration, insurance, cash payments'),
      sharePct: Number.isFinite(shareB) ? shareB : 50,
    },
    gstBasis: settings.distribution_gst_basis === 'inc_gst' ? 'inc_gst' : 'ex_gst',
    gstRateBp: Number(settings.gst_rate_bp) || 1000,
  };
}

/** Splits an integer gross AUD cent amount (positive or negative) into GST and ex-GST cents. */
export function splitGstFromGross(grossCents, gstRateBp = 1000) {
  const gross = Math.round(Number(grossCents || 0));
  const sign = gross < 0 ? -1 : 1;
  const abs = Math.abs(gross);
  const gst = Math.round((abs * gstRateBp) / (10000 + gstRateBp));
  const signedGst = sign * gst;
  return {
    grossCents: gross,
    gstCents: signedGst,
    exGstCents: gross - signedGst,
  };
}

function splitOnlinePayment(p, gstRateBp) {
  const grossCents = Math.round(Number(p.amountCents || 0));
  if (
    p.kind === 'payment' &&
    typeof p.subtotalCents === 'number' &&
    typeof p.gstCents === 'number' &&
    Math.round(p.subtotalCents) + Math.round(p.gstCents) === grossCents
  ) {
    return {
      grossCents,
      gstCents: Math.round(p.gstCents),
      exGstCents: Math.round(p.subtotalCents),
    };
  }
  return splitGstFromGross(grossCents, gstRateBp);
}

/** Computes contractor totals, GST breakdown, net entitlement, settlement balance, and unified chronological entries. */
export function computeLedger({ payments = [], ledgerEntries = [], settings = {}, from = '', to = '' }) {
  const cfg = ledgerConfig(settings);
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);

  let onlineGrossCents = 0;
  let onlineGstCents = 0;
  let onlineExGstCents = 0;

  let cashAGrossCents = 0;
  let cashAGstCents = 0;
  let cashAExGstCents = 0;
  let cashBGrossCents = 0;
  let cashBGstCents = 0;
  let cashBExGstCents = 0;

  let distributedAToBCents = 0;
  let distributedBToACents = 0;

  const entries = [];

  for (const p of payments) {
    const ms = Date.parse(p.createdAt || '');
    const entryDate = Number.isFinite(ms) ? brisbaneDate(ms) : '';
    if (entryDate && !inRange(entryDate)) continue;
    const { grossCents, gstCents, exGstCents } = splitOnlinePayment(p, cfg.gstRateBp);
    onlineGrossCents += grossCents;
    onlineGstCents += gstCents;
    onlineExGstCents += exGstCents;

    entries.push({
      id: p.id,
      source: 'payment',
      kind: p.kind === 'refund' ? 'refund' : 'payment',
      entryDate,
      createdAt: p.createdAt || '',
      grossCents,
      gstCents,
      exGstCents,
      distributionCents: 0,
      partyLabel: cfg.contractorA.name,
      fromContractor: null,
      toContractor: null,
      collectedBy: 'contractor_a',
      method: p.provider || 'stripe',
      reference: p.providerRef || '',
      bookingRef: p.bookingRef || '',
      provider: p.provider || 'stripe',
      note: p.note || (p.bookingRef ? `Booking ${p.bookingRef}` : ''),
      createdByName: p.provider === 'demo' ? 'System (Demo)' : 'Stripe',
      deletable: false,
    });
  }

  for (const e of ledgerEntries) {
    const entryDate = String(e.entryDate || '');
    if (entryDate && !inRange(entryDate)) continue;

    if (e.kind === 'cash_payment') {
      const gross = Math.round(Number(e.grossAudCents ?? 0));
      const gst = typeof e.gstAudCents === 'number'
        ? Math.round(e.gstAudCents)
        : splitGstFromGross(gross, cfg.gstRateBp).gstCents;
      const exGst = typeof e.netExGstAudCents === 'number' && Math.round(e.netExGstAudCents) + gst === gross
        ? Math.round(e.netExGstAudCents)
        : gross - gst;
      const collector = e.collectedBy === 'contractor_a' ? 'contractor_a' : 'contractor_b';
      if (collector === 'contractor_a') {
        cashAGrossCents += gross;
        cashAGstCents += gst;
        cashAExGstCents += exGst;
      } else {
        cashBGrossCents += gross;
        cashBGstCents += gst;
        cashBExGstCents += exGst;
      }
      entries.push({
        id: e.id,
        source: 'ledger',
        kind: 'cash_payment',
        entryDate,
        createdAt: e.createdAt || '',
        grossCents: gross,
        gstCents: gst,
        exGstCents: exGst,
        distributionCents: 0,
        partyLabel: collector === 'contractor_a' ? cfg.contractorA.name : cfg.contractorB.name,
        fromContractor: null,
        toContractor: null,
        collectedBy: collector,
        method: 'cash',
        reference: e.bookingRef || '',
        bookingRef: e.bookingRef || '',
        provider: 'cash',
        note: e.note || '',
        createdByName: e.createdByName || '',
        deletable: true,
      });
    } else if (e.kind === 'distribution') {
      const amount = Math.round(Number(e.amountAudCents ?? 0));
      const fromC = e.fromContractor === 'contractor_b' ? 'contractor_b' : 'contractor_a';
      const toC = fromC === 'contractor_a' ? 'contractor_b' : 'contractor_a';
      if (fromC === 'contractor_a') distributedAToBCents += amount;
      else distributedBToACents += amount;

      const fromName = fromC === 'contractor_a' ? cfg.contractorA.name : cfg.contractorB.name;
      const toName = toC === 'contractor_a' ? cfg.contractorA.name : cfg.contractorB.name;
      entries.push({
        id: e.id,
        source: 'ledger',
        kind: 'distribution',
        entryDate,
        createdAt: e.createdAt || '',
        grossCents: 0,
        gstCents: 0,
        exGstCents: 0,
        distributionCents: amount,
        partyLabel: `${fromName} -> ${toName}`,
        fromContractor: fromC,
        toContractor: toC,
        collectedBy: null,
        method: e.method || 'bank_transfer',
        reference: e.reference || '',
        bookingRef: '',
        provider: e.method || 'bank_transfer',
        note: e.note || '',
        createdByName: e.createdByName || '',
        deletable: true,
      });
    }
  }

  entries.sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const cashGrossCents = cashAGrossCents + cashBGrossCents;
  const cashGstCents = cashAGstCents + cashBGstCents;
  const cashExGstCents = cashAExGstCents + cashBExGstCents;

  const totalGrossCents = onlineGrossCents + cashGrossCents;
  const totalGstCents = onlineGstCents + cashGstCents;
  const totalExGstCents = onlineExGstCents + cashExGstCents;

  const heldA = cfg.gstBasis === 'inc_gst'
    ? (onlineGrossCents + cashAGrossCents)
    : (onlineExGstCents + cashAExGstCents);
  const heldB = cfg.gstBasis === 'inc_gst'
    ? cashBGrossCents
    : cashBExGstCents;
  const distributablePoolCents = heldA + heldB;

  const gstHeldACents = onlineGstCents + cashAGstCents;
  const gstHeldBCents = cashBGstCents;

  const entitlementACents = Math.round((distributablePoolCents * cfg.contractorA.sharePct) / 100);
  const entitlementBCents = distributablePoolCents - entitlementACents;

  const netDistributedAToBCents = distributedAToBCents - distributedBToACents;
  const netRetainedACents = heldA - netDistributedAToBCents;
  const netRetainedBCents = heldB + netDistributedAToBCents;

  const owedAToBCents = netRetainedACents - entitlementACents;
  const settlement = owedAToBCents > 0
    ? { from: 'contractor_a', to: 'contractor_b', amountCents: owedAToBCents }
    : owedAToBCents < 0
      ? { from: 'contractor_b', to: 'contractor_a', amountCents: -owedAToBCents }
      : { from: null, to: null, amountCents: 0 };

  return {
    config: cfg,
    filter: { from, to },
    summary: {
      onlineGrossCents,
      onlineGstCents,
      onlineExGstCents,
      cashGrossCents,
      cashGstCents,
      cashExGstCents,
      totalGrossCents,
      totalGstCents,
      totalExGstCents,
      distributablePoolCents,
      distributedAToBCents,
      distributedBToACents,
      netDistributedAToBCents,
      owedAToBCents,
      settlement,
      contractorA: {
        ...cfg.contractorA,
        grossCollectedCents: onlineGrossCents + cashAGrossCents,
        gstHeldCents: gstHeldACents,
        exGstCollectedCents: onlineExGstCents + cashAExGstCents,
        heldForSplitCents: heldA,
        entitlementCents: entitlementACents,
        distributionsOutCents: distributedAToBCents,
        distributionsInCents: distributedBToACents,
        netRetainedCents: netRetainedACents,
        balanceCents: -owedAToBCents, // positive means owed to A; negative means A owes B
      },
      contractorB: {
        ...cfg.contractorB,
        grossCollectedCents: cashBGrossCents,
        gstHeldCents: gstHeldBCents,
        exGstCollectedCents: cashBExGstCents,
        heldForSplitCents: heldB,
        entitlementCents: entitlementBCents,
        distributionsOutCents: distributedBToACents,
        distributionsInCents: distributedAToBCents,
        netRetainedCents: netRetainedBCents,
        balanceCents: owedAToBCents, // positive means owed to B; negative means B owes A
      },
    },
    entries,
  };
}

function csvCell(val) {
  const s = String(val ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Formats the ledger view as RFC-4180 CSV with AUD dollar columns. */
export function ledgerToCsv(view) {
  const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const header = [
    'Date', 'Kind', 'Party / Direction', 'Method', 'Gross AUD', 'GST AUD', 'Ex-GST AUD', 'Distribution AUD', 'Reference', 'Note', 'Recorded By',
  ];
  const rows = view.entries.map((e) => [
    e.entryDate,
    e.kind,
    e.partyLabel,
    e.method,
    dollars(e.grossCents),
    dollars(e.gstCents),
    dollars(e.exGstCents),
    dollars(e.distributionCents),
    e.reference || e.bookingRef || '',
    e.note || '',
    e.createdByName || '',
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

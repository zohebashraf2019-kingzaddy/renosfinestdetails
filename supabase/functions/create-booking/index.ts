// Supabase Edge Function: create-booking
// Takes a booking from the website plus a Square card token, charges the deposit through the
// Square Payments API, saves the booking in quote_requests (kind = 'booking'), and emails the
// owner and the customer.
//
// Secrets (supabase secrets set ...):
//   SQUARE_ACCESS_TOKEN  — Square access token (Developer Dashboard → Credentials). Never expose it.
//   SQUARE_LOCATION_ID   — the location that receives the payments
//   SQUARE_ENVIRONMENT   — "production" (default) or "sandbox"
//   DEPOSIT_CENTS        — optional, defaults to 5000 ($50)
//   SMTP_* / OWNER_EMAIL / FROM_NAME — see _shared/mail.ts
//   ALLOWED_ORIGINS      — optional, comma-separated site origins

import { createClient } from 'npm:@supabase/supabase-js@2';
import { detailsTable, escapeHtml, ownerEmails, sendMail } from '../_shared/mail.ts';

// Must match BOOKABLE_SERVICES in src/lib/business.ts exactly.
const SERVICES = [
  'Interior Only – Standard ($120)',
  'Interior Only – Premium ($190)',
  'Spot Cleaning ($115)',
  'Exterior & Interior – Standard ($165)',
  'Exterior & Interior – Premium ($240)',
  'One-Step Polish (from $400)',
  'Two-Step Polish (from $600)',
  'RV Wash Only ($7/ft)',
  'RV Wash & Wax ($9/ft)',
  'Boat Wash & Wax ($10/ft)',
  'Maintenance Plan – Bi-Weekly ($90)',
  'Maintenance Plan – Monthly ($120)',
  'Maintenance Plan – Every 3 Weeks ($105)',
];
// Must match BOOKING_TIMES in src/lib/business.ts exactly.
// Open 6 AM – 8 PM; details take 2–4 hours, so the last start time is 4 PM.
const TIMES = ['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM'];
// Dates closed to new online bookings (inclusive). Must match BLOCKED_DATES in src/lib/business.ts exactly.
const BLOCKED_DATES = [{ from: '2026-11-01', to: '2026-11-09' }];
// Must match BUSINESS.cancelHours in src/lib/business.ts.
const CANCEL_HOURS = 48;
const METHODS = ['Phone call', 'Text message', 'Email'];
const MAX_PER_HOUR_PER_IP = 8;
const SQUARE_VERSION = '2024-10-17';

const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  const allow = allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function prettyDate(d: string) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** Today's date in Reno (Pacific), as YYYY-MM-DD. */
function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

const DECLINE_MESSAGES: Record<string, string> = {
  CARD_DECLINED: 'Your card was declined. Please try another card.',
  GENERIC_DECLINE: 'Your card was declined. Please try another card.',
  INSUFFICIENT_FUNDS: 'Your card was declined for insufficient funds.',
  CVV_FAILURE: 'The security code (CVV) didn\'t match. Please check it and try again.',
  ADDRESS_VERIFICATION_FAILURE: 'The ZIP code didn\'t match your card. Please check it and try again.',
  INVALID_EXPIRATION: 'The card\'s expiration date is invalid.',
  INVALID_CARD: 'That card number is invalid.',
  CARD_EXPIRED: 'That card has expired.',
  TRANSACTION_LIMIT: 'This charge exceeds your card\'s limit. Please try another card.',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { ok: false, error: 'Method not allowed.' });

  const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN') ?? '';
  const locationId = Deno.env.get('SQUARE_LOCATION_ID') ?? '';
  if (!accessToken || !locationId) {
    console.error('Square is not configured (SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID missing)');
    return json(req, 503, { ok: false, error: 'Online booking is not available right now. Please call or text us to book.' });
  }
  const squareBase = (Deno.env.get('SQUARE_ENVIRONMENT') ?? 'production').toLowerCase() === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  const depositCents = Number(Deno.env.get('DEPOSIT_CENTS') ?? '5000') || 5000;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { ok: false, error: 'Invalid request.' });
  }

  // Honeypot for bots. Never fake a confirmed booking: return an error instead.
  if (str(body.rfd_hp, 200)) {
    console.warn('honeypot filled, booking rejected');
    return json(req, 400, { ok: false, error: 'Please refresh the page and try again. Your card was not charged.' });
  }

  const data = {
    name: str(body.name, 100),
    phone: str(body.phone, 30),
    email: str(body.email, 200).toLowerCase(),
    location: str(body.location, 100),
    vehicle: str(body.vehicle, 150),
    service: str(body.service, 100),
    preferred_date: str(body.date, 10),
    preferred_time: str(body.time, 20),
    contact_method: str(body.method, 30) || 'Text message',
    message: str(body.message, 2000) || null,
  };
  const sourceId = str(body.sourceId, 500);
  const verificationToken = str(body.verificationToken, 1000);
  const idempotencyKey = str(body.idempotencyKey, 45);

  const errors: string[] = [];
  if (data.name.length < 2) errors.push('name');
  if (data.phone.replace(/\D/g, '').length < 10) errors.push('phone number');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) errors.push('email address');
  if (!data.location) errors.push('city / area');
  if (!data.vehicle) errors.push('vehicle');
  if (!SERVICES.includes(data.service)) errors.push('service');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.preferred_date) || data.preferred_date <= todayPacific()) errors.push('date');
  if (!TIMES.includes(data.preferred_time)) errors.push('time');
  if (BLOCKED_DATES.some((r) => data.preferred_date >= r.from && data.preferred_date <= r.to)) {
    return json(req, 409, { ok: false, error: 'Sorry, that date is fully booked. Please choose another date.', slotTaken: true });
  }
  if (!METHODS.includes(data.contact_method)) data.contact_method = 'Text message';
  if (body.agree !== true && body.agree !== 'true' && body.agree !== 'on') errors.push('agreement to the deposit policy');
  if (!sourceId) errors.push('card details');
  if (idempotencyKey.length < 10) errors.push('session — please refresh the page');
  if (errors.length) return json(req, 400, { ok: false, error: `Please check your ${errors.join(', ')}.` });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // Same submit retried (double click, flaky network): don't charge twice.
  const { data: existing } = await supabase
    .from('quote_requests')
    .select('id, payment_status, receipt_url')
    .eq('payment_idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing?.payment_status === 'paid') {
    return json(req, 200, { ok: true, id: existing.id, receiptUrl: existing.receipt_url });
  }

  // Rate limit per IP (hashed).
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ip_hash = await sha256(ip + (Deno.env.get('SUPABASE_URL') ?? ''));
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('quote_requests')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ip_hash)
    .gte('created_at', since);
  if ((count ?? 0) >= MAX_PER_HOUR_PER_IP) {
    return json(req, 429, { ok: false, error: 'Too many attempts — please try again later or call us.' });
  }

  // Slot still free?
  const { count: taken } = await supabase
    .from('quote_requests')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'booking')
    .in('payment_status', ['paid', 'waived'])
    .eq('preferred_date', data.preferred_date)
    .eq('preferred_time', data.preferred_time);
  if ((taken ?? 0) > 0) {
    return json(req, 409, { ok: false, error: 'Sorry, that time was just booked. Please pick another time.', slotTaken: true });
  }

  // Save first (pending), so every charge has a record.
  let rowId = existing?.id as string | undefined;
  if (!rowId) {
    const { data: row, error } = await supabase
      .from('quote_requests')
      .insert({
        ...data,
        kind: 'booking',
        status: 'new',
        deposit_cents: depositCents,
        payment_status: 'pending',
        payment_idempotency_key: idempotencyKey,
        ip_hash,
      })
      .select('id')
      .single();
    if (error || !row) {
      console.error('insert failed', error);
      return json(req, 500, { ok: false, error: 'Something went wrong saving your booking. Your card was not charged.' });
    }
    rowId = row.id;
  }

  // Charge the deposit.
  const note = `Deposit — ${data.service} — ${data.preferred_date} ${data.preferred_time} — ${data.name}`.slice(0, 500);
  let payment: Record<string, any> | null = null;
  let declineMsg = '';
  try {
    const res = await fetch(`${squareBase}/v2/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        ...(verificationToken ? { verification_token: verificationToken } : {}),
        amount_money: { amount: depositCents, currency: 'USD' },
        location_id: locationId,
        autocomplete: true,
        reference_id: rowId,
        note,
        buyer_email_address: data.email,
      }),
    });
    const out = await res.json();
    if (res.ok && out.payment && ['COMPLETED', 'APPROVED'].includes(out.payment.status)) {
      payment = out.payment;
    } else {
      const code = out?.errors?.[0]?.code as string | undefined;
      console.error('square payment failed', res.status, JSON.stringify(out?.errors ?? out));
      declineMsg = (code && DECLINE_MESSAGES[code]) || 'Your payment could not be processed. Please check your card details and try again.';
    }
  } catch (e) {
    console.error('square request error', e);
    declineMsg = 'We couldn\'t reach the payment processor. Your card was not charged. Please try again.';
  }

  if (!payment) {
    await supabase.from('quote_requests').update({ payment_status: 'failed' }).eq('id', rowId);
    return json(req, 402, { ok: false, error: declineMsg });
  }

  const receiptUrl: string | null = payment.receipt_url ?? null;
  const paidPatch = { payment_status: 'paid', square_payment_id: payment.id, receipt_url: receiptUrl };
  const { error: upErr } = await supabase.from('quote_requests').update(paidPatch).eq('id', rowId);
  let doubleBooked = false;
  if (upErr) {
    // Most likely someone else paid for the same slot a moment earlier (unique index).
    console.error('mark paid failed', upErr);
    doubleBooked = true;
    await supabase
      .from('quote_requests')
      .update({
        square_payment_id: payment.id,
        receipt_url: receiptUrl,
        notes: `PAID ($${(depositCents / 100).toFixed(2)}, Square ${payment.id}) but the time slot was already taken — contact the customer to reschedule.`,
      })
      .eq('id', rowId);
  }

  // Emails (best effort — the booking and payment are already saved).
  const deposit = `$${(depositCents / 100).toFixed(2)}`;
  const when = `${prettyDate(data.preferred_date)} at ${data.preferred_time}`;
  const rows: [string, string][] = [
    ['When', when],
    ['Service', data.service],
    ['Deposit paid', `${deposit} (Square payment ${payment.id})`],
    ['Name', data.name],
    ['Phone', data.phone],
    ['Email', data.email],
    ['City / Area', data.location],
    ['Vehicle', data.vehicle],
    ['Preferred contact', data.contact_method],
    ['Notes', data.message ?? 'None'],
  ];
  const ownerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="margin:0 0 4px;color:#e23d3c">New booking — ${deposit} deposit paid</h2>
      ${doubleBooked ? '<p style="color:#b00;font-weight:bold">⚠ This time slot was already booked by someone else. Contact this customer to reschedule.</p>' : ''}
      <p style="margin:0 0 18px;color:#555">${escapeHtml(when)}</p>
      ${detailsTable(rows)}
      <p style="margin-top:20px">
        <a href="tel:${escapeHtml(data.phone)}" style="background:#e23d3c;color:#fff;padding:10px 16px;text-decoration:none;display:inline-block">Call ${escapeHtml(data.name)}</a>
        ${receiptUrl ? `&nbsp; <a href="${escapeHtml(receiptUrl)}">Square receipt</a>` : ''}
      </p>
    </div>`;
  const emailed = await sendMail({
    to: ownerEmails(),
    replyTo: { name: data.name, address: data.email },
    subject: `${doubleBooked ? '⚠ DOUBLE-BOOKED: ' : ''}New booking: ${data.name} — ${prettyDate(data.preferred_date)} ${data.preferred_time}`,
    html: ownerHtml,
    text: [`New booking — ${deposit} deposit paid`, ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n'),
  });
  if (emailed) await supabase.from('quote_requests').update({ email_sent: true }).eq('id', rowId);

  const owner = ownerEmails()[0];
  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;color:#222">
      <h2 style="margin:0 0 6px;color:#e23d3c">You're booked, ${escapeHtml(data.name.split(' ')[0])}!</h2>
      <p>Thanks for booking with Reno's Finest Details. We received your ${deposit} deposit, and it goes toward your total.</p>
      ${detailsTable([
        ['When', when],
        ['Service', data.service],
        ['Vehicle', data.vehicle],
        ['Area', data.location],
        ['Deposit paid', deposit],
      ])}
      <p>Juan will reach out to confirm the details. Final prices may vary depending on the size, condition, and services requested.</p>
      <p style="font-size:13px;color:#555"><strong>Cancellation &amp; rescheduling policy:</strong> cancel or reschedule at least ${CANCEL_HOURS} hours before your appointment and your deposit is refunded. Cancellations or reschedules made less than ${CANCEL_HOURS} hours before are non-refundable.</p>
      ${receiptUrl ? `<p><a href="${escapeHtml(receiptUrl)}">View your payment receipt</a></p>` : ''}
      <p>Questions or changes? Call or text <a href="tel:+17758570381">(775) 857-0381</a>${owner ? ` or reply to this email` : ''}.</p>
    </div>`;
  await sendMail({
    to: [data.email],
    replyTo: owner ? { name: "Reno's Finest Details", address: owner } : undefined,
    subject: `Booking confirmed: ${prettyDate(data.preferred_date)} at ${data.preferred_time}`,
    html: customerHtml,
    text: `You're booked! ${when}\nService: ${data.service}\nDeposit paid: ${deposit}\nCancel or reschedule at least ${CANCEL_HOURS} hours before your appointment for a deposit refund; within ${CANCEL_HOURS} hours it's non-refundable.\nQuestions: (775) 857-0381`,
  });

  return json(req, 200, { ok: true, id: rowId, receiptUrl, doubleBooked });
});

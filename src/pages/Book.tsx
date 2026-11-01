import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from '../lib/router';
import { supabase } from '../lib/supabase';
import { BOOKABLE_SERVICES, BOOKING_TIMES, BUSINESS, CONTACT_METHODS, DEPOSIT_POLICY, SQUARE, isBlockedDate } from '../lib/business';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    Square?: any;
  }
}

type Status = { kind: 'idle' | 'paying' | 'error'; text: string };
type Done = { when: string; service: string; receiptUrl: string | null; doubleBooked: boolean };

const SDK_URL = SQUARE.sandbox ? 'https://sandbox.web.squarecdn.com/v1/square.js' : 'https://web.squarecdn.com/v1/square.js';

/** YYYY-MM-DD in Reno time, offset by `days`. */
function pacificDate(days = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function prettyDate(d: string) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function loadSquare(): Promise<any> {
  if (window.Square) return Promise.resolve(window.Square);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const s = existing ?? document.createElement('script');
    s.addEventListener('load', () => resolve(window.Square));
    s.addEventListener('error', () => reject(new Error('Square failed to load')));
    if (!existing) {
      s.src = SDK_URL;
      s.async = true;
      document.head.appendChild(s);
    }
  });
}

const CARD_STYLE = {
  '.input-container': { borderColor: '#495056', borderRadius: '0px' },
  '.input-container.is-focus': { borderColor: '#e23d3c' },
  '.input-container.is-error': { borderColor: '#f26a68' },
  '.message-text': { color: '#a8afb5' },
  '.message-icon': { color: '#a8afb5' },
  '.message-text.is-error': { color: '#f26a68' },
  '.message-icon.is-error': { color: '#f26a68' },
  input: { backgroundColor: '#121619', color: '#ffffff', fontSize: '16px' },
  'input::placeholder': { color: '#8b959c' },
};

export function Book() {
  const enabled = !!supabase && !!SQUARE.applicationId && !!SQUARE.locationId;
  const initialService = (() => {
    const s = new URLSearchParams(window.location.search).get('service') ?? '';
    return BOOKABLE_SERVICES.includes(s) ? s : '';
  })();

  const [service, setService] = useState(initialService);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [taken, setTaken] = useState<string[]>([]);
  const [cardReady, setCardReady] = useState(false);
  const [cardError, setCardError] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [done, setDone] = useState<Done | null>(null);
  const cardRef = useRef<any>(null);

  // Mount the Square card field.
  useEffect(() => {
    if (!enabled || done) return;
    let cancelled = false;
    (async () => {
      try {
        const Square = await loadSquare();
        if (cancelled) return;
        const payments = Square.payments(SQUARE.applicationId, SQUARE.locationId);
        const card = await payments.card({ style: CARD_STYLE });
        if (cancelled) return card.destroy();
        await card.attach('#card-container');
        cardRef.current = card;
        setCardReady(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) setCardError(`The card form couldn't load. Please refresh the page, or call ${BUSINESS.phoneDisplay} to book.`);
      }
    })();
    return () => {
      cancelled = true;
      cardRef.current?.destroy?.();
      cardRef.current = null;
      setCardReady(false);
    };
  }, [enabled, done]);

  // Which start times are already booked on the chosen date.
  const refreshTaken = async (d: string) => {
    if (!supabase || !d) return setTaken([]);
    const { data } = await supabase.rpc('booked_slots', { d });
    setTaken(Array.isArray(data) ? (data as unknown[]).map((x) => (typeof x === 'string' ? x : (x as any)?.booked_slots)).filter(Boolean) : []);
  };
  useEffect(() => {
    refreshTaken(date);
  }, [date]);
  const dayBlocked = isBlockedDate(date);
  useEffect(() => {
    if (time && (dayBlocked || taken.includes(time))) setTime('');
  }, [taken, time, dayBlocked]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase || !cardRef.current) return;
    if (dayBlocked) return setStatus({ kind: 'error', text: 'That date is fully booked. Please choose another date.' });
    if (!time) return setStatus({ kind: 'error', text: 'Please choose a start time.' });
    const form = e.currentTarget;
    const d = new FormData(form);
    setStatus({ kind: 'paying', text: 'Processing your deposit…' });

    // Tokenize the card (Square handles any bank verification in its own popup).
    let token = '';
    try {
      const [given, ...rest] = String(d.get('name') ?? '').trim().split(/\s+/);
      const details = {
        amount: BUSINESS.deposit.toFixed(2),
        currencyCode: 'USD',
        intent: 'CHARGE',
        customerInitiated: true,
        sellerKeyedIn: false,
        billingContact: { givenName: given, familyName: rest.join(' '), email: String(d.get('email') ?? ''), phone: String(d.get('phone') ?? '') },
      };
      let result: any;
      try {
        result = await cardRef.current.tokenize(details);
      } catch {
        result = await cardRef.current.tokenize();
      }
      if (result.status !== 'OK') {
        const msg = result.errors?.[0]?.message ?? 'Please check your card details.';
        return setStatus({ kind: 'error', text: msg });
      }
      token = result.token;
    } catch (err) {
      console.error(err);
      return setStatus({ kind: 'error', text: 'Please check your card details and try again.' });
    }

    const payload = {
      ...Object.fromEntries(d.entries()),
      service,
      date,
      time,
      agree: d.get('agree') === 'on',
      sourceId: token,
      idempotencyKey: crypto.randomUUID(),
    };
    const { data, error } = await supabase.functions.invoke('create-booking', { body: payload });

    if (error || !data?.ok || !data?.id) {
      let msg = data?.error as string | undefined;
      let slotTaken = !!data?.slotTaken;
      if (!msg && error && 'context' in error) {
        try {
          const j = await (error as { context: Response }).context.json();
          msg = j?.error;
          slotTaken = !!j?.slotTaken;
        } catch {
          /* ignore */
        }
      }
      if (slotTaken) {
        setTime('');
        refreshTaken(date);
      }
      return setStatus({ kind: 'error', text: msg ?? `We couldn't complete your booking. Your card was not charged. Please try again or call ${BUSINESS.phoneDisplay}.` });
    }

    setDone({ when: `${prettyDate(date)} at ${time}`, service, receiptUrl: data.receiptUrl ?? null, doubleBooked: !!data.doubleBooked });
    setStatus({ kind: 'idle', text: '' });
    window.scrollTo(0, 0);
  }

  const paying = status.kind === 'paying';

  return (
    <main id="book-page">
      <section className="page-hero">
        <div className="wrap">
          <div className="eyebrow">BOOK ONLINE</div>
          <h1>{done ? "YOU'RE BOOKED." : 'BOOK YOUR DETAIL.'}</h1>
          <p>
            {done
              ? 'Thank you! A confirmation is on its way to your email.'
              : `Pick your service and time, then secure it with a $${BUSINESS.deposit} deposit that goes toward your total.`}
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 50 }}>
        <div className="wrap">
          {done ? (
            <div className="book-done">
              <div className="policy" style={{ marginTop: 0 }}>
                <div>
                  <div className="eyebrow">CONFIRMED</div>
                  <h3>{done.when.toUpperCase()}</h3>
                </div>
                <ul>
                  <li>{done.service}</li>
                  <li>${BUSINESS.deposit} deposit paid. It goes toward your total.</li>
                  <li>{BUSINESS.owner} will reach out to confirm the details.</li>
                  {done.doubleBooked && <li style={{ color: '#f26a68' }}>That time was booked by someone else at the same moment. We'll contact you to pick a new time.</li>}
                </ul>
              </div>
              <div className="actions">
                {done.receiptUrl && (
                  <a className="btn ghost" href={done.receiptUrl} target="_blank" rel="noopener">VIEW RECEIPT ↗</a>
                )}
                <Link className="btn" href="/">BACK TO HOME →</Link>
              </div>
              <p className="form-note" style={{ marginTop: 22 }}>
                Need to cancel or reschedule? Call or text <a href={BUSINESS.phoneHref}>{BUSINESS.phoneDisplay}</a>.{' '}
                {DEPOSIT_POLICY.refundable} {DEPOSIT_POLICY.nonRefundable}
              </p>
            </div>
          ) : !enabled ? (
            <div className="policy" style={{ marginTop: 0 }}>
              <div>
                <div className="eyebrow">ONLINE BOOKING</div>
                <h3>COMING SOON.</h3>
              </div>
              <ul>
                <li>Call or text <a href={BUSINESS.phoneHref}>{BUSINESS.phoneDisplay}</a> to book now.</li>
                <li>Or <Link href="/#contact">send a detail request</Link> and we'll get back to you.</li>
              </ul>
            </div>
          ) : (
            <form className="book-layout" onSubmit={onSubmit}>
              <div className="book-main">
                <div className="book-step">
                  <h3><span>01 /</span> SERVICE</h3>
                  <div className="field">
                    <label htmlFor="b-service">WHAT ARE WE DETAILING? *</label>
                    <select id="b-service" required value={service} onChange={(e) => setService(e.target.value)}>
                      <option value="">Select a service</option>
                      {BOOKABLE_SERVICES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <p className="form-note">
                    Trucks, SUVs and third-row vehicles add $20 to Exterior &amp; Interior packages. Fleet work or not sure?{' '}
                    <Link href="/#contact">Request a quote instead</Link>.
                  </p>
                </div>

                <div className="book-step">
                  <h3><span>02 /</span> DATE &amp; TIME</h3>
                  <div className="field">
                    <label htmlFor="b-date">DATE *</label>
                    <input id="b-date" type="date" required min={pacificDate(1)} max={pacificDate(120)} value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                  <label className="slots-label">START TIME *</label>
                  {date ? (
                    <div className="slots" role="radiogroup" aria-label="Start time">
                      {BOOKING_TIMES.map((t) => {
                        const isTaken = dayBlocked || taken.includes(t);
                        return (
                          <button
                            type="button"
                            key={t}
                            role="radio"
                            aria-checked={time === t}
                            disabled={isTaken}
                            className={'slot' + (time === t ? ' active' : '')}
                            onClick={() => setTime(t)}
                          >
                            {t}
                            {isTaken && <small>BOOKED</small>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="form-note">Choose a date to see available times.</p>
                  )}
                  {dayBlocked && <p className="form-note" style={{ color: '#f26a68' }}>This date is fully booked. Please choose another date.</p>}
                  <p className="form-note">Open {BUSINESS.hours}. {BUSINESS.hoursNote}</p>
                </div>

                <div className="book-step">
                  <h3><span>03 /</span> YOUR DETAILS</h3>
                  <div className="fields">
                    <div className="field">
                      <label htmlFor="b-name">FULL NAME *</label>
                      <input id="b-name" name="name" required maxLength={100} autoComplete="name" placeholder="Your name" />
                    </div>
                    <div className="field">
                      <label htmlFor="b-phone">PHONE NUMBER *</label>
                      <input id="b-phone" name="phone" type="tel" required maxLength={30} autoComplete="tel" placeholder="(775) 000-0000" />
                    </div>
                    <div className="field">
                      <label htmlFor="b-email">EMAIL ADDRESS *</label>
                      <input id="b-email" name="email" type="email" required maxLength={200} autoComplete="email" placeholder="you@example.com" />
                    </div>
                    <div className="field">
                      <label htmlFor="b-location">SERVICE ADDRESS / AREA *</label>
                      <input id="b-location" name="location" required maxLength={100} placeholder="Reno, Sparks, Carson City, Truckee…" />
                    </div>
                    <div className="field">
                      <label htmlFor="b-vehicle">VEHICLE / RV / BOAT *</label>
                      <input id="b-vehicle" name="vehicle" required maxLength={150} placeholder="2022 Ford Explorer, 34 ft RV…" />
                    </div>
                    <div className="field">
                      <label htmlFor="b-method">PREFERRED CONTACT</label>
                      <select id="b-method" name="method" defaultValue="Text message">
                        {CONTACT_METHODS.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field full">
                      <label htmlFor="b-message">NOTES</label>
                      <textarea id="b-message" name="message" maxLength={2000} placeholder="Stains, pet hair, add-ons you want, gate codes, or RV/boat length in feet." />
                    </div>
                    {/* Spam trap: hidden from people. Named so browser autofill never fills it. */}
                    <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
                      <label htmlFor="b-hp">Leave this empty</label>
                      <input id="b-hp" name="rfd_hp" type="text" tabIndex={-1} autoComplete="new-password" defaultValue="" />
                    </div>
                  </div>
                </div>

                <div className="book-step">
                  <h3><span>04 /</span> ${BUSINESS.deposit} DEPOSIT</h3>
                  <div id="card-container" className={cardReady ? 'ready' : ''} />
                  {!cardReady && !cardError && <p className="form-note">Loading secure card form…</p>}
                  {cardError && <p className="form-note" style={{ color: '#f26a68' }}>{cardError}</p>}
                  <label className="agree">
                    <input type="checkbox" name="agree" required />
                    <span>
                      I agree to the deposit policy: the ${BUSINESS.deposit} deposit goes toward my total and is refundable if I cancel or
                      reschedule at least {BUSINESS.cancelHours} hours before my appointment. Cancellations or reschedules made less than{' '}
                      {BUSINESS.cancelHours} hours before are non-refundable.
                    </span>
                  </label>
                  <button className="btn" type="submit" disabled={paying || !cardReady} style={{ width: '100%', opacity: paying || !cardReady ? 0.7 : 1 }}>
                    {paying ? 'PROCESSING…' : `PAY $${BUSINESS.deposit} DEPOSIT & BOOK →`}
                  </button>
                  <p className="form-note" aria-live="polite" style={status.kind === 'error' ? { color: '#f26a68' } : undefined}>
                    {status.text || 'Payments are processed securely by Square. Your card details never touch our servers.'}
                  </p>
                </div>
              </div>

              <aside className="book-summary">
                <div className="eyebrow">YOUR BOOKING</div>
                <dl>
                  <dt>Service</dt>
                  <dd>{service || '—'}</dd>
                  <dt>When</dt>
                  <dd>{date ? `${prettyDate(date)}${time ? ` at ${time}` : ''}` : '—'}</dd>
                  <dt>Due today</dt>
                  <dd className="due">${BUSINESS.deposit}.00 deposit</dd>
                </dl>
                <p>The deposit goes toward your total. Final prices may vary depending on the size, condition, and services requested.</p>
                <p>
                  Questions? <a href={BUSINESS.phoneHref}>{BUSINESS.phoneDisplay}</a>
                </p>
                <Link href="/services">See all prices →</Link>
              </aside>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

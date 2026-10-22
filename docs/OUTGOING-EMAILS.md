# Outgoing emails

Every email Nuclear sends, for design. Today all of them are plain text; the decision (Dami, 2026-10-22) is to move to **HTML emails**. Dami is preparing the designs and will send them; nothing here is built in HTML yet.

Code: templates in `apps/api/src/lib/email.ts`, sending in `sendMail()` (same file), link building in `lib/accountMail.ts` and `lib/orgMail.ts`.

## How they are sent

- Through the Cloudflare Email Service `EMAIL` binding, from `Nuclear <noreply@nclr.app>` (`EMAIL_FROM`). **`nclr.app` must be a verified sending domain** before anything is delivered.
- One message per recipient. No cc, no reply-to today (several emails say "reply to this email"; either add a monitored reply-to or reword).
- A send never fails the action that caused it. The outcome is `sent`, `failed`, `not_configured` or `suppressed`.
- **Never sent to seeded demo domains** (`seed.nuclear.test` and its subdomains).
- Sign-off today: "The Nuclear team". Greeting: "Hello {name},".

## What changes when we go HTML

1. `sendMail()` takes `{ to, subject, text, html }`. **Keep a plain-text part for every email** (deliverability, accessibility, clients that block HTML); the designs need a text version of each, or we derive it.
2. One shared layout (header/logo, footer, colors) plus one body per email. Only the body differs.
3. Email clients need table layout, inline CSS, web-safe or fallback fonts, images hosted at an absolute `https://` URL, and dark-mode tolerance. Nuclear's house style (black/white, `--pop` inversion) may need adapting.
4. Buttons must be real links with the full URL also shown as text below the button (some clients strip buttons).
5. Where a link carries a one-time token, the token is in the query string; do not put it anywhere else in the design.

## Shared pieces to design once

- Header (logo/wordmark) and footer (company name, mailing address if required, "sent by Nuclear", support contact).
- Primary button, secondary text link, the "if you didn't do this" security note, a money/amount treatment, a callout box for a reason or a warning.
- Legal footer content is not decided (CAN-SPAM postal address, unsubscribe). These are transactional emails; none has marketing content.

## The emails

Variables are in `{braces}`. Amounts are shown as dollars (`$1,234.56`).

### Account security (every account type)

**1. Verify email**
- Subject: `Verify your email for Nuclear`
- Sent to: the new account's email. When: at sign-up, and when the person taps "Send Verification Email" on their profile (a newer link replaces older ones).
- Variables: `{name}`, `{link}`.
- Link: `{portal}/verify-email?token=…`, valid **24 hours**, single use. `{portal}` is the customer app (`APP_URL`), the merchant portal (businesses) or the organization portal (organizations).
- Current copy: confirm this is your email by opening the link within 24 hours; ignore this if you didn't create a Nuclear account.

**2. Reset password**
- Subject: `Reset your Nuclear password`
- Sent to: the account's email. When: someone asks for a reset on the sign-in page.
- Variables: `{name}`, `{link}`.
- Link: `{portal}/reset-password?token=…`, valid **1 hour**, single use.
- Current copy: open the link within one hour to choose a new password; resetting signs you out everywhere; ignore if you didn't ask.

**3. Password changed**
- Subject: `Your Nuclear password was changed`
- Sent to: the account's email. When: right after a reset link was used.
- Variables: `{name}`. No link.
- Current copy: password changed with a reset link, every device signed out; if it wasn't you, reply right away. (Needs a real contact route.)

### Businesses (merchant approval)

**4. Business approved**
- Subject: `Your Nuclear business account is approved`
- When: an admin approves a pending or declined business. Variables: `{name}`. No link today (could add a sign-in button to the merchant portal).
- Current copy: your business account is approved; sign in and start accepting payments.

**5. Business needs attention (declined)**
- Subject: `Your Nuclear business account needs attention`
- When: an admin declines a pending business. Variables: `{name}`, `{reason}` (5 to 1000 characters written by the admin, can be several lines).
- Current copy: could not approve yet; the reason; sign in, upload a corrected business document and we will review it again. Could add a sign-in/upload button.

**6. Admin email to merchants**
- Subject and body are written by an admin in the admin portal. `{{name}}` is replaced with each merchant's name.
- The compose window offers five starting templates and Custom: **Welcome**, **Documents needed**, **Under review**, **Approved**, **Action required** (copy in `apps/admin-portal/src/views/EmailMerchants.tsx`). These need designs as HTML templates; the admin's free text goes inside the layout. Plain paragraphs only (decide whether admins may use bold/links).
- Sent to one merchant, a chosen list, or every active/pending merchant (up to 200 at a time), one message each.

### Employees (employer benefits)

**7. Benefit received (unclaimed)**
- Subject: `{org} sent you {amount} on Nuclear`
- Sent to: an employee who has no Nuclear account yet. When: an employer credits them (CSV, API or the fixed schedule; the schedule only sends this the first time).
- Variables: `{name}`, `{org}`, `{amount}`, `{link}`.
- Link: `{APP_URL}/claim?token=…` (the claim page is **not built yet**; the token is single use, a newer email replaces it).
- Current copy: claim it in one step by signing in or signing up; never expires; spendable at every participating Nuclear merchant.

**8. Benefit reminder (unclaimed)**
- Subject: `Your {amount} from {org} is waiting on Nuclear`
- Sent to: an employee still holding unclaimed money. When: the daily job, every 30 days, with a fresh link. Same variables and link as #7. Also sent for employees who were later removed but still have credit held.

### Organizations (employers)

**9. Low funds warning**
- Subject: `Add funds before {date}: your scheduled benefits need {total}`
- Sent to: the organization's email. When: up to 3 days before a Fixed Benefits payment the wallet cannot cover.
- Variables: `{org}`, `{date}` (e.g. "Friday, November 15"), `{total}`, `{balance}`. Could add an "Add Funds" button to the organization portal.
- Current copy: if still short on the day we retry daily for three days, then mark the payment missed.

**10. Scheduled payment missed**
- Subject: `Your {date} benefits payment was missed`
- When: the retries are over. Variables: `{org}`, `{date}`, `{total}`, `{reason}` (today: "the wallet could not cover it" or a short code).
- Current copy: nobody was charged and no employee was credited; the next scheduled payment is unchanged; credit them now from the Benefits page or API.

## Not built, may want designs

| Candidate | Why it might be needed |
| --- | --- |
| Welcome (after verifying) | First touch after sign-up; per account type |
| Money received (a send) | Customers get no email when someone sends them money |
| Payout sent / payout returned / collection notice | Merchant settlement now exists and emails nobody |
| Refund issued | Customer-facing receipt for a refund |
| Receipt for a store purchase | Bands/cards and shop orders |
| Benefit claimed confirmation | To employee after claiming; to employer is not needed |
| Organization suspended / reactivated, merchant suspended / reactivated | Admin actions that today tell nobody |
| New sign-in or new device alert | Security |
| API key generated or rotated (organization) | Security |

Decide which of these to build once the core ten have a design.

## Open questions for the design

1. Reply-to address, and who reads it (emails 3, 5 and 10 say "reply").
2. Footer content: postal address, support contact, any legal text.
3. Brand: logo files (hosted where), colors, typeface, light/dark behavior.
4. Do the portals' emails show the portal name ("Nuclear Business", "Nuclear Organization") or just "Nuclear"?
5. Locale: US English, dollars only for now.

When designs arrive, send one file per email (HTML) plus the shared layout, with the variables written as `{name}` etc. as above, and the plain-text version if it differs from the HTML.

# Two-way texting (SMS inbox) — Twilio setup

Vibe T&B's SMS inbox lets clients text your firm and lets staff reply from **Messages → SMS**. Reminders, booking confirmations, and document-request notices go out through the same channel, so a client's reply threads back to the message that prompted it. The firm brings its own Twilio account; Vibe never holds your credentials on our side.

## 1. Twilio account and number

1. Create (or sign in to) your Twilio account at console.twilio.com.
2. Buy a **local 10-digit number** (or port your existing business number). Toll-free numbers work too and skip 10DLC, but need toll-free verification.
3. Note the **Account SID** and **Auth Token** (Account → API keys & tokens). Optionally create an **API Key** (Standard) — you can use the key/secret for sending while the Auth Token stays required for webhook signature checks.

## 2. Messaging Service

1. Messaging → Services → **Create Messaging Service** (use case: "Notify my users").
2. Add your number(s) to the service's **Sender Pool**.
3. Under **Integration**, choose **Send a webhook** for incoming messages. Paste the **Inbound URL** from Admin → SMS inbox → Webhooks (it looks like `https://<your-public-host>/api/sms/twilio/inbound`, HTTP POST).
4. Under **Opt-Out Management**, enable **Advanced Opt-Out** so carriers get the standard STOP/START replies. Vibe honors STOP/START locally as well.
5. Copy the **Messaging Service SID** (`MG…`).

## 3. Enter credentials in Vibe

Admin → **Email + SMS providers** → SMS provider = Twilio:

- Messaging Service SID (`MG…`)
- Account SID, Auth Token (required)
- API Key SID / Secret (optional)

Click **Test connection** — it verifies the credentials and reads the Messaging Service and its numbers. Save.

Then Admin → **SMS inbox**:

- Enable the inbox.
- **Refresh from Twilio** to pull your numbers in as _lines_. Give each a label, choose whether it ingests inbound texts, set a default assignee, and pick the default line for new outbound texts.
- Check the **Public base URL** — this must be the origin Twilio can reach (your Cloudflare tunnel or public hostname). Signature validation uses it.
- Click **Check 10DLC now** (see §4).

## 4. US A2P 10DLC registration

US carriers require **Brand + Campaign** registration for application-to-person texting on local numbers. Register in Twilio Console → Messaging → Regulatory Compliance → A2P 10DLC, and attach the campaign to your Messaging Service. Until Twilio reports the campaign as **verified**, Vibe blocks texts to US long codes (a banner explains why). Toll-free and short-code senders are exempt; an admin can override the block in Admin → SMS inbox if you use one.

## 5. Behind NAT or a firewall

Self-hosted appliances often can't be reached directly. Options:

- Use the built-in Cloudflare Tunnel (Admin → Cloudflare tunnel) so the public host proxies to the appliance.
- Any other tunnel/reverse proxy works — just set **Public base URL** to the public origin.

Even if the webhook never reaches you, texts still arrive: the appliance **polls Twilio** every few minutes (Admin → SMS inbox → Polling interval). The Health card shows a warning when polling finds texts the webhook missed.

## 6. Consent and opt-out (what Vibe enforces)

- A client texting you first is consent — replies in that thread are always allowed.
- Firm-initiated texts (reminders, booking confirmations, a staff "New text") require consent on file: the booking form and portal checkboxes, a client turning texts on in the portal, or staff recording verbal consent on the person record. A reminder held for missing consent notifies the appointment lead.
- STOP/UNSUBSCRIBE opts the contact out immediately; START/UNSTOP opts back in. Twilio error 21610 (sent to an unsubscribed number) also flips the flag.

## 7. Pictures and files (MMS)

Inbound attachments are pulled from Twilio, stored in your firm's file storage, handed to **Document Intake** (AI naming applies), then **deleted from Twilio**. Outbound MMS isn't supported yet.

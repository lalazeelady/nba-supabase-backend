# CONFIG-TODO — third-party settings that code cannot reach

Companion to the `pipeline-field-parity` branch. Everything here lives in the
**CallTools**, **Ringba** or **Caliber** UI. None of it is a code change, and
nothing in the branch depends on it — the code sends/accepts the fields either
way, so these items only decide whether the data actually lands.

Ordered by value. Percentages are production, rolling 3–14 days, queried 3 Sep 2026.

---

## The chain, and why it leaks

```
funnel ──POST──> submit-lead ──> CallTools contact
                              └─> Caliber (direct API)

CallTools ──enrich URL──> Ringba User tags ──pixel──> Supabase webhook
             (ACA XFER)      [tag:User:x]              raw_payload
```

Two hops, two independent failure modes, and they compound:

1. **The enrich URL can only read fields that exist on the CallTools contact.**
   It is templated as `{{%locals[contact][<field>]}}`. If `submit-lead` never
   posted the field, or posted it under a different name, the token resolves to
   an empty string — silently.
2. **The pixel can only read Ringba User tags the enrich actually set.** It is
   templated as `[tag:User:<name>]`, and the name must match the enrich's query
   parameter **exactly**. A near-miss resolves empty — also silently.

Nothing anywhere logs a token that failed to resolve. Both hops fail quietly,
which is why these gaps survived so long.

---

## 1. Ringba pixels: the name tokens don't match the tags — HIGH

Both pixels read:

```
&first_name=[tag:User:First name]&last_name=[tag:User:last name]
```

The enrich URL sets the tags `firstname` and `lastname` (no space, all
lowercase). `First name` and `last name` match nothing.

**Evidence — there are two pixel variants in production, and one works:**

| pixel variant | events (3d) | `first_name` populated | `zip` populated |
|---|---:|---:|---:|
| without an `address` param | 2,753 | **0 (0%)** | **0 (0%)** |
| with an `address` param | 724 | 715 (99%) | 710 (98%) |

79% of Ringba postbacks arrive with **no name and no zip**. That directly costs
Google Ads match quality: Enhanced Conversions for Leads uses a hashed
first+last+postal block, and without all three that identifier is dropped
(`upload-google-offline-conversions` requires `first && last && zip`).

**Fix — in both `RingbaToSupaGglOfflineCV-Monet` and `-Xfer`:**

```diff
- &first_name=[tag:User:First name]&last_name=[tag:User:last name]
+ &first_name=[tag:User:firstname]&last_name=[tag:User:lastname]
```

Then bring the two variants into line so every campaign fires the same pixel.
Verify with the query in *How to verify* below — `first_name` should jump from
~21% to ~99% within an hour.

---

## 2. Ringba already holds call context it never sends back — HIGH

The enrich URL hands Ringba far more than the pixels return. These tags are
**already populated**; they are simply not on the postback URL.

| add to the pixel | Ringba tag | already stored by | today |
|---|---|---|---|
| `&ib_source=` | `[tag:User:ib_source]` | `offline_conversion_events.ib_source` | **0 / 19,898** from Ringba; 6,612 / 6,612 from Caliber |
| `&city=` | `[tag:User:city]` | `caller_city` *(new this branch)* | — |
| `&state=` | `[tag:User:state]` | `caller_state` | 99 / 10,715 |
| `&zip=` | `[tag:User:zipcode]` | `caller_zip` | 98 / 10,715 |
| `&agent_name=` | `[tag:User:agent_name]` | `agent_name` | 0 |
| `&queue=` | `[tag:User:queueid]` | `queue` | 0 |

`ib_source` is the highest value of these: it is the inbound route — effectively
*which phone number was dialled* — so it separates funnel calls from thank-you
calls from popup calls. Caliber sends it on 100% of its postbacks; Ringba on
none, purely because the token is absent.

Note the name mismatch to watch: the enrich sets `zipcode`, the webhook parses
`zip` / `zip_code` / `zipCode` / `postal_code`. Send it as `&zip=[tag:User:zipcode]`.

---

## 3. `ip_address` resolves empty because CallTools never had it — HIGH

The pixels read `[tag:User:ip_address]`. It has resolved **0 times out of 3,477**
in three days.

Root cause is the first hop, not the pixel: `submit-lead` was never sending an IP
to CallTools, so there was no contact field for the enrich URL to read. **This
branch fixes the code half** — `ip_address` is now in the CallTools payload
(populated on 100% of leads).

**Remaining steps, in order:**

1. Create a custom field on the CallTools contact named exactly `ip_address`.
2. Confirm the enrich URL carries `&ip_address={{%locals[contact][ip_address]}}`
   (it may already — the URL is truncated in the screenshot after
   `jornaya_lead_id`).
3. No pixel change needed; `[tag:User:ip_address]` already reads it.

Until step 1, the branch still improves matters: the webhooks now backfill
`ip_address` from the matched lead, so the ~64% of events that match a lead get
an IP regardless of what Ringba sends.

---

## 4. RESOLVED IN CODE — three fields were posted under the wrong name

The CallTools API response echoes the **entire contact record** back on every
create. Reading it (Sep 2026) settled several open questions at once, including
the long-standing "CallTools silently drops `employment_status`" note in
`DECISIONS.md`. That was never a missing field — it was a **name mismatch**.

Confirmed real fields on the CallTools contact, vs. what we were sending:

| CallTools field | we were sending | status |
|---|---|---|
| `employment` | `employment_status` | **fixed in this branch** — the gap in `DECISIONS.md` |
| `oppref_id` | `oppref` | **fixed in this branch** |
| `trusted_form` | only `jornaya_lead_id` | **fixed** — now sends both; the enrich URL reads `trusted_form` |
| `consent_url` | nothing | **fixed** — now carries the referring funnel URL |

`DECISIONS.md` should be corrected: the fix for `employment_status` was a code
change, not "add a custom field in the CallTools account".

**Watch after deploy.** These four values are now posted to fields that exist.
If `employment` turns out to be a constrained enum rather than free text,
CallTools will 400 the request (it does not retry 4xx) and the lead will land in
`leads` with `crm_status='failed'` plus a Resend alert. `citizenship` already
accepts the same style of snake_case value on this contact, so free text is the
expectation — but confirm with:

```sql
select crm_status, count(*) from leads
where created_at > now() - interval '20 minutes' group by 1;
```

Any spike in `failed` means roll back by reverting the four renames.

## 5. New CallTools custom fields for the fields this branch starts sending — MED

`submit-lead` now posts these. CallTools ignores a field it has no mapping for,
so **nothing breaks if you skip this** — but they will not be visible to agents,
and the enrich URL cannot forward them to Ringba, until the fields exist.

Confirmed absent from the contact schema (checked against the API response echo),
so each needs creating. Create as a contact custom field with the **exact** name:

| field | value | why it matters |
|---|---|---|
| `ip_address` | caller IP | unblocks §3 |
| `landing_page` | `apply2` / `bg1` / `oa1` / `info01` / `apply0` | which funnel variant converted — the A/B readout |
| `user_agent` | browser UA | TCPA evidence; a valid Google ECL signal |
| `referrer` | referring URL | TCPA evidence |
| `needs` | `food,utility,housing,other` | the stated intent, currently collected and thrown away |
| `ttclid`, `li_fat_id`, `twclid`, `epik` | click ids | TikTok / LinkedIn / X / Pinterest, for when those channels run |
| `pubid` | publisher id | **already exists** on the contact (as do `pub_id`, `ib_source`, `source`, `traffic_source`) — no need to create, we now fill it |

Once they exist, add matching `&<name>={{%locals[contact][<name>]}}` params to the
enrich URL, then matching `&<name>=[tag:User:<name>]` params to both pixels.

---

## 6. UTMs never reach Ringba at all — MED

No pixel carries any `utm_*` param, and the enrich URL doesn't set them either.
The webhooks compensate by backfilling UTMs from the matched lead — but **36% of
Ringba events (7,130 of 19,902 in 14 days) match no lead**, and those keep blank
campaign attribution permanently.

`submit-lead` has always sent all five UTMs to CallTools, so the contact has
them. Add to the enrich URL, then to both pixels:

```
&utm_source={{%locals[contact][utm_source]}}   ->  &utm_source=[tag:User:utm_source]
&utm_medium=...  &utm_campaign=...  &utm_content=...  &utm_term=...
```

Same treatment for `msclkid`, `fbclid` and `oppref` — all three are already in
the CallTools payload and reach neither Ringba nor its postback.

---

## 7. Caliber — LOW

- **Confirm the `address` and `city` key names.** `submit-lead` sends
  `contact.address` / `contact.city` on the assumption they mirror CallTools.
  Caliber silently drops unrecognized field names, so if they're wrong we lose
  them with no error. Ask them to confirm against their ingest spec.
- **Ask Caliber to echo `zip`, `state` and `ip_address` on the conversion pixel.**
  Their postback carries UTMs and every click id but no address fields at all
  (`caller_zip` and `caller_state` are 0 / 6,612). Zip in particular would lift
  Google ECL match rates for the internet-buyer path.
- **`agent_name` and `queue` arrive as empty strings** on 100% of Caliber
  postbacks — the keys are present, the values never are. Worth one question.

---

## 8. Cosmetic — LOW

The enrich URL builds `fullname` by concatenating with no separator:

```
&fullname={{%locals[contact][first_name]}}{{%locals[contact][last_name]}}
```

which produces `JaneSmith`. Nothing downstream consumes `fullname` (we parse
`first_name` / `last_name` separately), so this is harmless — but if anyone ever
reads it in Ringba reporting, insert a `%20`.

---

## How to verify, after each change

Run in the Supabase SQL editor. Every token that resolved empty shows as a key
present with a blank value, so `nonempty` is the number that matters:

```sql
select k, count(*) total, count(*) filter (where v <> '') nonempty
from offline_conversion_events oce,
     lateral jsonb_each_text(oce.raw_payload) as e(k,v)
where oce.source = 'ringba'
  and oce.created_at > now() - interval '2 hours'
group by k order by nonempty desc, k;
```

Baseline before any of the above (3 days): `ip_address` 0 / 3,477 ·
`first_name` 714 / 3,477 · `zip` 709 of the 723 payloads that carried the param ·
`ib_source` absent entirely.

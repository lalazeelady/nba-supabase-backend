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

## 4. PARTLY RESOLVED IN CODE — and one open question for CallTools

The CallTools API response echoes the **entire contact record** back on every
create. Reading it (Sep 2026) settled several open questions, including the
long-standing "CallTools silently drops `employment_status`" note in
`DECISIONS.md` — that was never a missing field, it was a **name mismatch**.

| CallTools field | we were sending | status |
|---|---|---|
| `oppref_id` | `oppref` | **fixed in this branch** — now lands |
| `trusted_form` | only `jornaya_lead_id` | **fixed** — sends both; the enrich URL reads `trusted_form` |
| `consent_url` | nothing | **fixed** — now carries the referring funnel URL |
| `employment` | `employment_status` | **BLOCKED — needs your input, see below** |

### `employment` is a constrained enum, and we don't know its choices

Renaming `employment_status` → `employment` was deployed and immediately
rejected by live traffic:

```
400 {"employment":["\"employed_full_time\" is not a valid choice."]}
400 {"employment":["\"unemployed\" is not a valid choice."]}
```

No leads were lost — the function retries a 400 without the offending field —
but the value still does not land. **We need CallTools' accepted choice list.**

Our four form values are `employed_full_time`, `employed_part_time`,
`unemployed`, `retired`. To close this, either:

1. Open the `employment` field in the CallTools UI and read its dropdown
   options, then tell me and I'll add the mapping (this is a 5-minute fix); **or**
2. Ask CallTools support for the accepted values; **or**
3. Create a *new* free-text custom field (e.g. `employment_status`) and we send
   our raw values there instead — no mapping needed.

Until then `submit-lead` deliberately sends the old, ignored `employment_status`
key, exactly as before. **Do not rename it back to `employment` without the
choice list.**

### Safety net (relevant to everything in §5)

On a 4xx, `submit-lead` parses CallTools' per-field error body and retries with
just the offending field(s) removed; if that doesn't parse, it retries once with
the field set that has worked for months. **A lead is never lost to a bad
field.** This is what makes the custom-field rollout below safe to do against
live traffic — if you create a field with the wrong type, you lose that field on
those leads, not the leads.

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

## 7. Caliber — questions only they can answer

The funnel posts to CallTools and Caliber **in parallel, from the same payload**.
After the `age` + `publisher` additions, the two are at parity: every canonical
column on `leads` reaches both, allowing for each destination's own field names
and enum vocabulary.

| canonical (`leads`) | → CallTools | → Caliber |
|---|---|---|
| `street_address` | `address` | `contact.address` *(unconfirmed)* |
| `city` | `city` | `contact.city` *(unconfirmed)* |
| `zip` | `zip_code` | `contact.zip` |
| `phone` | `home_phone_number` | `contact.phone` |
| `annual_income` | numeric (`50000`) | range label (`25_50k`) |
| `employment_status` | *(not sent — enum mismatch, §4)* | `full_time` / `part_time` / … |
| `citizenship` | raw | 3 values folded to 2 |
| `trusted_form_cert_url` | `jornaya_lead_id` + `trusted_form` | `consent.jornaya_leadid` + `consent.trustedform_cert_url` |
| `ip_address` | `ip_address` | `consent.ip` |
| `user_agent` | `user_agent` | `consent.user_agent` |
| `referrer` | `consent_url` + `referrer` | `consent.url` + `attribution.referrer` |
| `age` | `age` | `extended.age` |
| `publisher` | `pubid` | `attribution.publisher` |
| `needs` | `needs` | `extended.needs` |

The per-destination renames and enum mappings are deliberate adapters. **`leads`
holds the canonical raw values** (`under_50k`, `employed_full_time`, …), so any
future CRM is a new adapter, not a re-derivation.

### Three things to ask Caliber

1. **Confirm `contact.address` and `contact.city` land.** We chose those key
   names by mirroring CallTools, never against their spec. Caliber drops an
   unrecognized field **silently** and its response is only
   `{status, lead_id, request_id}` — no echo of what was accepted. So if the
   names are wrong we are shipping incomplete leads to a buyer with no error and
   no way to detect it from our side. This is the single highest-value question
   here.
2. **Ask for their full accepted-field list.** Same reason: we cannot discover it
   from responses the way we could with CallTools. Without it, "complete and
   consistent" is an assumption rather than a fact.
3. **Ask them to echo `zip`, `state` and `ip_address` on the conversion pixel.**
   Their postback carries UTMs and every click id but no address fields at all
   (`caller_zip` and `caller_state` are 0 / 6,612). Zip in particular would lift
   Google ECL match rates on the internet-buyer path. Also: `agent_name` and
   `queue` arrive as empty strings on 100% of Caliber postbacks — the keys are
   present, the values never are.

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

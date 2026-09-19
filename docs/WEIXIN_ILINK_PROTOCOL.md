# weixin-ilink protocol evidence

> Status: current — Stage 11A evidence for the external `weixin-ilink`
> provider; every claim is anchored to the sources cited in
> [Sources](#sources) or to a requirement this document converts into a test.

`weixin-ilink` is Aria's third canonical channel: a personal-WeChat bot
account on Tencent's official iLink bot protocol. It is **not** the existing
`wechat-kf` (WeCom customer service) integration and shares no code, state,
credentials, or identity with it. The provider ships as an external package
behind the Stage 9/10 trust and composition boundaries and stays disabled by
default.

## Legality and licensing

- The service is an official Tencent product — 微信ClawBot插件功能 — gated by
  Tencent's dedicated ClawBot terms of use (《微信ClawBot功能使用条款》).
  Deployments must accept those terms through the QR authorization flow; the
  protocol itself is documented by Tencent, not reverse-engineered.
- The reference implementation `@tencent-weixin/openclaw-weixin` is MIT
  licensed. Aria may study its wire behavior and reproduce protocol shapes;
  any copied code must carry attribution.
- Operational lessons from community bridges (cc-connect and similar) are
  converted into requirements below. Aria takes no dependency on their
  architecture or code.

## Transport

All post-login traffic is HTTP/JSON against the account's `baseurl` returned
at login. The two QR-login endpoints are a fixed Tencent service and never
use `baseurl`.

Every request carries:

| Header | Value |
| --- | --- |
| `iLink-App-Id` | Provider application ID |
| `iLink-App-ClientVersion` | Provider version as an unsigned integer |
| `SKRouteTag` | Optional configured route tag |

`POST` requests additionally carry `Content-Type: application/json`,
`AuthorizationType: ilink_bot_token`, and a base64-encoded random uint32
`X-WECHAT-UIN`. Authenticated requests carry `Authorization: Bearer
<bot-token>`; QR status `GET` polls do not. `POST` bodies include
`base_info` (`channel_version`, `bot_agent`); `bot_agent` is a self-declared
observability label and never participates in auth or routing.

## Endpoint inventory

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/ilink/bot/get_bot_qrcode?bot_type=3` | Create a QR login session |
| `GET` | `/ilink/bot/get_qrcode_status?qrcode=<id>` | Poll QR status; optional `verify_code` |
| `POST` | `/ilink/bot/msg/notifystart` | Notify backend the channel started |
| `POST` | `/ilink/bot/msg/notifystop` | Notify backend the channel stopped |
| `POST` | `/ilink/bot/getupdates` | Long-poll inbound messages |
| `POST` | `/ilink/bot/sendmessage` | Send text/image/video/file |
| `POST` | `/ilink/bot/getuploadurl` | CDN upload pre-signed parameters |
| `POST` | `/ilink/bot/getconfig` | Account config (typing ticket) |
| `POST` | `/ilink/bot/sendtyping` | Send/cancel typing indicator |

## Authentication lifecycle

1. `get_bot_qrcode` accepts `local_token_list` — up to 10 previously issued
   `bot_token` values — and returns an opaque `qrcode` id plus
   `qrcode_img_content` (the URL rendered as the QR code). Tokens are
   sensitive and never enter logs, plans, or diagnostics.
2. `get_qrcode_status` is polled until a terminal state:
   `wait` → `scaned` → `confirmed`, or `need_verifycode` /
   `verify_code_blocked` (verification challenge via `verify_code`), or
   `expired`, `scaned_but_redirect`, `binded_redirect`.
3. `confirmed` returns `bot_token` (the bearer), `ilink_bot_id` (account
   ID), and `baseurl` (account API base URL). All three are persisted:
   `bot_token` behind a secret reference only; `baseurl` is account-specific
   and must be stored because it is required for every subsequent call.
4. `notifystart` runs when the runtime starts, `notifystop` when it drains.
5. `errcode: -14` on any authenticated call means the bearer is stale: the
   runtime moves to `reauth-required` and stops polling until a new login
   intent lands.

A pre-provisioned bearer is a legitimate first-class path (community
bridges expose a token-bind equivalent): the provider must accept an
existing `bot_token` + `baseurl` through the secret boundary without
requiring a QR round-trip.

## Inbound path

`getupdates` long-polls; the server holds the request until messages arrive
or ~35 s elapse. Request body is `{ "get_updates_buf": "<cursor>" }` — empty
string for the first poll. The response returns `ret`, `msgs`,
`get_updates_buf`, and an optional `longpolling_timeout_ms` hint for the
next request.

The cursor contract is the reliability core: `get_updates_buf` must be
persisted and passed back verbatim on every poll. Reusing a stale cursor
redelivers messages; losing it can drop or duplicate history. Aria's rule:
**the provider cursor advances only after ordered durable acceptance of the
envelopes it covers.**

## Message model

`WeixinMessage` carries `seq`, `message_id`, `from_user_id`, `to_user_id`,
`client_id`, `create_time_ms`, `session_id`, `group_id`, `message_type`
(`1` = USER, `2` = BOT), `message_state` (`0` = NEW, `1` = GENERATING,
`2` = FINISH), `item_list`, and `context_token`.

`context_token` is conversation-scoped opaque state: replies must echo it
back verbatim. It is stored as `replyContext` on the normalized envelope —
never logged.

`MessageItem` types: `text_item` (`{ text }`), `image_item`, `voice_item`
(SILK), `file_item`, `video_item`, `ref_msg` (quoted/referenced message),
and `tool_call_start_item`/`tool_call_result_item`. `text_item` and
`ref_msg` normalize into the envelope text; `image_item` and `file_item`
are implemented in Stage 12A; `voice_item`, `video_item`, and tool items
remain unsupported.

## Outbound path

`sendmessage` takes `msg.to_user_id`, `msg.context_token`, and an
`item_list`; a text reply is one item `{ type: 1, text_item: { text } }`.
Response is `{ ret, errmsg }`. Aria requires a checkpoint before delivery
and a deterministic receipt derived from `deliveryId`.

## Media pipeline (Stage 12A implemented)

All media moves through the CDN (`novac2c.cdn.weixin.qq.com/c2c`) under
AES-128-ECB: `getuploadurl` yields `upload_full_url`/`upload_param`, the
ciphertext is `POST`ed as `application/octet-stream`, and the response's
`x-encrypted-param` becomes `CDNMedia.encrypt_query_param`. Downloads use
`CDNMedia.full_url` + `aes_key`. Typing uses `getconfig` → `typing_ticket`
then `sendtyping` (`status` 1 = typing, 2 = cancel).

## Converted requirements

Community-operations lessons restated as Aria requirements:

- R1: `baseurl` is account-specific; store it with the account record, never
  assume the fixed service.
- R2: QR wait is bounded (≈8 min); expiry is a first-class outcome, not an
  error.
- R3: Admission control must exist — an allowlist equivalent keyed on the
  ilink user id, since anyone who finds the bot can talk to it.
- R4: No skip-verify or insecure flag ships to production paths.
- R5: `local_token_list` and every token-shaped value are secret material.
- R6: `-14`/auth failures surface `reauth-required` through the ABI state
  projection, not retries forever.
- R7: Multi-account isolation comes from instance-scoped state (token,
  baseurl, cursor); nothing is shared across instances.

## Sources

- `openclaw-weixin` backend API reference (community mirror of the Tencent
  plugin docs): `openclaw-weixin.newfuture.cc/en/backend-api.html`
- `Tencent/openclaw-weixin` (MIT): `github.com/Tencent/openclaw-weixin`,
  npm `@tencent-weixin/openclaw-weixin`
- `chenhg5/cc-connect` weixin guide: `github.com/chenhg5/cc-connect` —
  operational lessons only

# Collection Profile 0.3.0 runtime implementer note

Status: Non-normative draft. This is implementation guidance for the lean
alternative to data-connectors #516, not an additional protocol contract or a
claim that DataConnect implements 0.3.0. The owner may adopt that alternative
instead of #516's current text. The normative authority remains [the Collection
Profile](https://github.com/PDP-Connect/data-connectors/blob/spec/collection-profile-0.3.0-lean/docs/spec/collection-profile.md).

Where this note restates a profile rule, the profile governs; nothing here adds a requirement.
Runtime descriptions below refer to the proposed reference-runtime design.

## 1. Admission and checkpoint sealing

The reference runtime separates admission from sealing. Admission accepts a
valid effect or fully validated debt durably. Sealing certifies an eligible
checkpoint and publishes its receipts and debt settlements. Already admitted
effects/debt can survive later failure; receipt, state and settlement from a
failed seal cannot. A recovery upsert follows the same admission policy after
the entire selected record is successfully read. While it remains partial, the
connector holds the whole record and preserves the retained row.

A practical admission transaction checks current grant, source account, selected
relationship, canonical parent attribution and placement fence. It records the
effect/debt and invalidates affected certifications together. Unvalidated gap
staging is provisional: receiving a message, incrementing a counter or seeing
later coverage does not admit debt. Runtime logs and local APIs distinguish
provisional staging from durable debt. An emitRecord helper can return a typed
local disposition, but only the host's durable write path attests admission. No
SDK or API spelling is part of the protocol.

At checkpoint sealing, the reference runtime evaluates the final ledger,
including earlier matching debt. It validates proposed full-original-obligation
seals against the ledger as it would stand after their atomic settlement, then
checks the complete outcome partition. This avoids requiring debt to disappear
before evaluating its proof. The reference runtime commits eligible state, new
receipts and every proved settlement together. A crash at any point yields all
three or none. A successful delete alone does not justify a checkpoint. An
independently eligible unaffected checkpoint can still commit under the
profile's certified stream-scoped failure exception.

## 2. Fixed placement generations and fencing

One implementation serializes placements per connection checkpoint. Another
assigns an expected generation at placement and keeps it fixed throughout the
run. Superseding placement or external invalidation advances the ledger's
current generation. In that implementation, each mutation transaction compares
expected and current generation, beyond the comparison at START or DONE. Stale
work cannot refresh its expectation to regain authority.

This implementation applies the fence to effect admission, gap creation/update,
receipt-dependent acceptance, gap credit, state, receipt publication and debt
settlement. Without its authority comparison, a final message, timestamp or
atomic write leaves stale work unfenced; other implementations can satisfy the
profile's observable fencing guarantee differently. Invalidation by the owning
run does not give that run a new expected generation. A rejected stale
transaction adds neither phantom debt nor stale effects; earlier valid
admissions remain durable.

The profile specifies the outcome: superseded work cannot alter effects, debt,
state or receipts. Expected generation numbers and this transaction ordering are
one way to obtain it, not a required wire mechanism or message member.

## 3. Receipt invalidation and epoch-bound state

Effect admission invalidates certifications whose materialization changes,
including old and new parent, relationship and scope memberships across original
obligations. A child move from P1 to P2 invalidates both parents. A delete
retains old membership for this calculation even without a new row. Where the
exact affected set cannot be established, the reference runtime conservatively
invalidates a broader set, up to every receipt and dependent state for that
detail stream and source account. Unknown dependencies leave no positive
certification.

Receipts also become unusable after scope changes, owner deletion, retention GC,
schema/transformation change, source-account change or relationship rename.
Known changes before launch reset dependent connector state before collection.
The reference runtime stores each dependent detail stream's transformation epoch
with checkpoint state. An unknown or different epoch triggers recollection, not
resume from an old cursor. A parser-fix epoch bump intentionally costs
recollection. Retained invalidated validators can be comparison-only history;
they cannot authorize unchanged, suppression or zero-effect complete.

At acceptance, the reference runtime validates receipt references against the
current ledger with no intervening invalidation. A START-delivered reference is
not a lease. On successful complete/empty commit, it supersedes prior receipts
only for the same obligation binding, including epoch/domain changes;
invalidation can affect a wider set. Legacy fingerprints and hydration flags
cannot manufacture receipts.

## 4. Retired relationships and source accounts

The reference runtime keeps debt under its original source account, scope,
relationship and obligation. A new account's successful collection never settles
or credits the old account's debt, and the old account is outside the new
account's denominator. Its connection identifier and source account remain
separate even when reauthorization reuses the connection. Equal validator text
does not establish account identity. It retains old-account debt without
presenting it as retry work for the new account.

A retired relationship's unresolved debt can be archived outside active
unrelated new-scope accounting, preserving its original binding and retirement
reason. Migration/settlement needs an explicit mapping proving semantic
relationship and scope equivalence plus full-original-obligation recollection.
Renaming a relationship or matching a validator is not that proof. Without it,
the debt stays archived and unresolved outside unrelated relationship
accounting.

Reference-runtime discovery supplies the full authorized active descriptor list
for the current account and exact normalized target; placement is refused if the
complete list exceeds a runtime bound. Excluded descriptors stay retained. Empty
discovery does not prove that no other-scope, retired or other-account debt
exists.

## 5. Integrity and recovery rationale

Connector candidate registration occurs at enumeration before parsing so
malformed values cannot shrink the required work. READ(value), EXPLICIT_EMPTY
and UNAVAILABLE are possible local results, not wire members. A source-empty
optional memo follows the schema's absence representation; an unreadable memo
cannot be relabeled absent to clear a retained field. A known-parent partial
read holds the entire record and creates cause-specific retryable debt. A
transport 503 can recover at the same epoch; a parser/mapped-value defect
requires a different detail transform epoch before refetch is offered. An
unknown parent withholds the affected boundary.

STREAM_EVIDENCE remains optional. Three unreadable children covered by one
parent locator are one gapped accounting unit while all three remain candidates.
Two unattributable candidates remain two ephemeral unaccounted units. Neither
the aggregate nor a child-set digest proves source completeness; the profile
requires no such digest, random batch identifier or source-completion receipt.

Time-range subranges can describe new debt at admission within one boundary,
when all remaining parts have independently closed and been accounted. They do
not replace outstanding debt. Version 0.3.0 deliberately defers residual
replacement: partial recovery leaves the original debt until a fresh full seal.
Opaque cursor ranges have equality only, so even new gap admission cannot infer
an uncovered suffix from endpoint spelling.

The profile's vectors are scenario contracts to run through real producers and
consumers. The corpus-integrity test checks traceability and structural
validity; it cannot prove source truth, transaction atomicity or implementation
conformance.

## 6. Positive state_stream sequence

A positive state_stream sequence uses a manifest where item_bodies inherits
items and the items relationship names item_bodies. START includes the resolved
items and item_bodies targets. With known parent item-2, the connector registers
three unparsed child candidates and emits one DETAIL_GAP for item_bodies,
parent_stream items, record_key item-2, reason connector_transform_failed,
retryable true and a shared item locator. Its binding supplies the exact
normalized item_bodies target, original inventory obligation and non-empty
bodies-v1 transform_epoch. The runtime validates and durably admits that gap
under the run's source account, current grant and unchanged placement generation.
Only then, if negotiated, STREAM_EVIDENCE may report considered:1 with
emitted:0, unchanged:0, gapped:1, unaccounted:0. The candidate ledger still
retains all three candidates. With parent enumeration closed, the connector
may emit the eligible items STATE, followed by successful DONE and exit 0;
the runtime applies the normal parent commit rules and the child inherits
that outcome. Neither the debt nor the optional aggregate proves completion
of the missing children. Omitting STREAM_EVIDENCE entirely remains valid
when all mandatory accounting holds; no child DETAIL_COVERAGE is introduced.

## 7. Portable recovery sequence

Portable recovery conformance sequence (no optional aggregate):

1. At epoch bodies-v1 and generation G1, START authorizes items and item_bodies
   and carries detail_debts:[]. A known item-2's child parse failure emits the
   bound DETAIL_GAP described in Section 6 with stream item_bodies and epoch bodies-v1.
   The runtime admits it; an otherwise eligible items STATE and successful
   DONE commit while the debt remains pending and no child baseline is minted.
2. The connector manifest changes item_bodies.transform_epoch to bodies-v2.
   Placement at G2 invalidates old epoch-bound state/receipts and sends the
   same authorized targets plus the stored descriptor D in START.detail_debts.
   D.binding retains bodies-v1 and the original inventory/range. No original
   bound is invented from the parent cursor. The changed epoch permits retry.
3. In the complete variant, the connector enumerates D's entire original obligation,
   the runtime durably accepts an attributed child RECORD, and enumeration closes
   with settled candidates. The connector emits this seal, copying D's literal
   locator and binding without change:
   ~~~json
   {
     "type": "DETAIL_GAP_RECOVERED", "reference_only": true,
     "stream": "item_bodies", "parent_stream": "items", "record_key": "item-2",
     "detail_locator": {"kind":"item","id":"item-2","obligation":{"kind":"inventory"}},
     "binding": {"effective_scope":{"name":"item_bodies"},"obligation":{"kind":"inventory"},"transform_epoch":"bodies-v1"},
     "transform_epoch":"bodies-v2", "outcome":"complete",
     "closure":{"enumeration_closed":true,"candidates_settled":true},
     "validator_domain":"bodies-v1"
   }
   ~~~
   It then emits {"type":"STATE","stream":"items","cursor":{"cursor":"next"}}
   and {"type":"DONE","status":"succeeded","records_emitted":1}, exiting 0.
   Under G2/current grant, the parent checkpoint transaction publishes state,
   complete-kind receipt and debt settlement together.
4. Empty variant starts from the SAME pending D, not the completed variant.
   The connector observes explicit source-empty inventory for D's full obligation,
   the runtime accepts any necessary attributed deletes, and the connector sends
   the same seal with outcome:"empty" and both closure booleans true. With no
   retained rows and no effects, records_emitted is 0 in successful DONE; with deletes it counts
   those RECORD messages. Eligible parent STATE commits an empty-kind receipt
   and settlement atomically. Zero emitted rows alone is not empty proof.
5. When closure is omitted, D's original bounds change, the parent is unknown,
   account/scope changes, G1 is replayed or only a successful sibling is supplied,
   the runtime rejects settlement. A failed parent commit leaves D pending and
   publishes neither new receipt nor state. Missing parent STATE also leaves D pending.
   Omitting STREAM_EVIDENCE in BOTH variants is conformant. A malformed
   recovery seal is never repaired by an aggregate or parent cursor.

Counts alone, authored screenshots, successful package installation and tests of
helper mirrors do not prove these cases. Source closure, truthful candidate
enumeration and gap reasons, required transformation-epoch changes, the original
obligation range, delta continuity and validator truth remain connector
assertions under mandatory Section 5.6 even when all runtime checks pass.
Fully accounted coverage can include durable gap debt; it does not mean that
every parent has the complete outcome.

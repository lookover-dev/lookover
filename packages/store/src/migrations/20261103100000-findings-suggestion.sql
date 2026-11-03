-- A finding keeps the finder's suggestion (`Finding.suggestion`, ADR 0074): every finding stored before it gets
-- `suggestion: null` (none offered), where the store keeps findings: each round's ledger, and each saved round's
-- ledger and plan (the reconciled round's ledger, what it raised and what it posts). A finding that has one keeps it.
UPDATE rounds SET findings = (
  SELECT json_group_array(json(json_insert(value, '$.suggestion', NULL)))
  FROM (SELECT value FROM json_each(rounds.findings) ORDER BY key)
);
UPDATE plans SET ledger = (
  SELECT json_group_array(json(json_insert(value, '$.suggestion', NULL)))
  FROM (SELECT value FROM json_each(plans.ledger) ORDER BY key)
);
UPDATE plans SET plan = json_set(
  plan,
  '$.post.reconciled.findings', json((
    SELECT json_group_array(json(json_insert(value, '$.suggestion', NULL)))
    FROM (SELECT value FROM json_each(plans.plan, '$.post.reconciled.findings') ORDER BY key)
  )),
  '$.post.reconciled.raised', json((
    SELECT json_group_array(json(json_insert(value, '$.suggestion', NULL)))
    FROM (SELECT value FROM json_each(plans.plan, '$.post.reconciled.raised') ORDER BY key)
  )),
  '$.post.reconciled.post', json((
    SELECT json_group_array(json(json_insert(value, '$.suggestion', NULL)))
    FROM (SELECT value FROM json_each(plans.plan, '$.post.reconciled.post') ORDER BY key)
  ))
)
WHERE json_type(plan, '$.post.reconciled') = 'object';

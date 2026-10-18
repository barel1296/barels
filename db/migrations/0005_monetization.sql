-- =============================================================================
-- Migration 0005 — monetization runtime: catalog approval, invoices, refunds
-- with four-eyes approval, and permissions.
-- =============================================================================

-- Products are drafted by one person and approved by another (four-eyes).
ALTER TABLE monetization.products
  ADD COLUMN created_by uuid REFERENCES core.users(id),
  ADD COLUMN retired_at timestamptz;

-- Orders keep the invoice link they were sold with and expire if unpaid.
ALTER TABLE monetization.orders
  ADD COLUMN invoice_link text,
  ADD COLUMN expires_at timestamptz;

-- Refund decisions: requested by one staff member, approved by another.
ALTER TABLE monetization.refunds
  ADD COLUMN requested_by_user uuid REFERENCES core.users(id),
  ADD COLUMN decided_by uuid REFERENCES core.users(id),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_note text,
  ADD COLUMN last_error jsonb,
  ADD CONSTRAINT refunds_four_eyes CHECK (decided_by IS NULL OR requested_by_user IS NULL OR decided_by <> requested_by_user);

-- At most one refund in flight per payment.
CREATE UNIQUE INDEX refunds_one_open_idx ON monetization.refunds (payment_id)
  WHERE status IN ('requested', 'pending_approval', 'processing');

CREATE INDEX payments_charge_idx ON monetization.payments (telegram_payment_charge_id);
CREATE INDEX star_transactions_unmatched_idx ON monetization.star_transactions (occurred_at)
  WHERE match_status = 'unmatched';

INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM core.roles r
  JOIN (VALUES
    ('owner', 'product.manage'), ('owner', 'product.approve'), ('owner', 'payment.read'), ('owner', 'offer.send'),
    ('owner', 'refund.request'), ('owner', 'refund.approve'), ('owner', 'entitlement.grant'),
    ('admin', 'product.manage'), ('admin', 'product.approve'), ('admin', 'payment.read'), ('admin', 'offer.send'),
    ('admin', 'refund.request'), ('admin', 'refund.approve'), ('admin', 'entitlement.grant'),
    ('content_manager', 'product.manage'),
    ('finance', 'product.approve'), ('finance', 'payment.read'), ('finance', 'refund.request'), ('finance', 'refund.approve'),
    ('finance', 'entitlement.grant'), ('finance', 'fan.read'),
    ('chat_operator', 'offer.send'), ('chat_operator', 'refund.request'),
    ('analyst', 'payment.read')
  ) AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.workspace_id IS NULL;

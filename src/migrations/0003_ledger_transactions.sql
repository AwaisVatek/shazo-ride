CREATE TABLE IF NOT EXISTS ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'fare_payment', 'commission', 'refund')),
    reference_id UUID,
    reference_type VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
    balance_after DECIMAL(10, 2) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_user_id ON ledger_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_created_at ON ledger_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_reference ON ledger_transactions(reference_id, reference_type);

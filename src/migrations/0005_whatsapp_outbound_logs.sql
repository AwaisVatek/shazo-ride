CREATE TABLE IF NOT EXISTS whatsapp_outbound_logs (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    instance_name VARCHAR(255),
    phone VARCHAR(20) NOT NULL,
    normalized_phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    request_payload JSONB,
    response_payload JSONB,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

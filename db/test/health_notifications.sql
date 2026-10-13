BEGIN;
DO $$
DECLARE
    organisation text := 'health-notification-test';
    owner_id uuid := gen_random_uuid();
    barrier_id uuid := gen_random_uuid();
    evidence_id uuid := gen_random_uuid();
    change_id uuid := gen_random_uuid();
    proposal_id uuid := gen_random_uuid();
BEGIN
    INSERT INTO app.app_user (id, org_id, keycloak_sub, created_by)
    VALUES (owner_id, organisation, 'synthetic-health-owner', 'health-notification-test');
    INSERT INTO app.barrier (id, org_id, type, side, health, owner_id, simulated, classification, created_by)
    VALUES (barrier_id, organisation, 'technical', 'preventive', 'healthy', owner_id, true, 'CONFIDENTIAL', 'health-notification-test');
    INSERT INTO app.evidence (id, org_id, barrier_id, kind, source, observed_at, simulated, classification, created_by)
    VALUES (evidence_id, organisation, barrier_id, 'inspection', 'synthetic', now(), true, 'CONFIDENTIAL', 'health-notification-test');
    INSERT INTO app.health_change (id, org_id, barrier_id, from_health, to_health, reason, actor, simulated, classification, created_by)
    VALUES (change_id, organisation, barrier_id, 'healthy', 'unverified', 'Evidence expired', 'ageing', true, 'CONFIDENTIAL', 'health-notification-test');
    INSERT INTO app.health_proposal (id, org_id, barrier_id, proposed_health, status, decided_by, reason,
        decision_key, decision_hash, decision_response, simulated, classification, created_by)
    VALUES (proposal_id, organisation, barrier_id, 'degraded', 'accepted', 'synthetic-health-owner', 'Inspection failed',
        repeat('a', 64), repeat('b', 64), '{"proposalId":"health-notification-test"}', true, 'CONFIDENTIAL', 'health-notification-test');
    INSERT INTO app.notification (org_id, action_request_id, health_change_id, channel, recipient_ref, status, receipt,
        sandbox, simulated, classification, created_by)
    VALUES (organisation, NULL, change_id, 'in_app', 'sandbox:' || owner_id::text, 'delivered', '{"kind":"health_change"}',
        true, true, 'CONFIDENTIAL', 'health-notification-test');
    INSERT INTO app.notification (org_id, action_request_id, evidence_id, channel, recipient_ref, status, receipt,
        sandbox, simulated, classification, created_by)
    VALUES (organisation, NULL, evidence_id, 'in_app', 'sandbox:' || owner_id::text, 'delivered', '{"kind":"evidence_expiry"}',
        true, true, 'CONFIDENTIAL', 'health-notification-test');

    BEGIN
        INSERT INTO app.notification (org_id, action_request_id, channel, recipient_ref, status, sandbox, simulated, classification, created_by)
        VALUES (organisation, NULL, 'in_app', 'sandbox:' || owner_id::text, 'delivered', true, true, 'CONFIDENTIAL', 'health-notification-test');
        RAISE EXCEPTION 'notification without exactly one subject was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO app.notification (org_id, health_change_id, evidence_id, channel, recipient_ref, status, receipt,
            sandbox, simulated, classification, created_by)
        VALUES (organisation, change_id, evidence_id, 'in_app', 'sandbox:' || owner_id::text, 'delivered', '{}',
            true, true, 'CONFIDENTIAL', 'health-notification-test');
        RAISE EXCEPTION 'notification with two subjects was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    IF (SELECT count(*) FROM app.notification WHERE org_id = organisation AND channel = 'in_app' AND simulation_retired_at IS NULL) <> 2 THEN
        RAISE EXCEPTION 'current notifications must expose both Health and Evidence subjects';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.health_proposal WHERE id = proposal_id AND decision_response IS NOT NULL AND simulation_retired_at IS NULL) THEN
        RAISE EXCEPTION 'Health Proposal idempotency response must be visible';
    END IF;
END $$;
ROLLBACK;

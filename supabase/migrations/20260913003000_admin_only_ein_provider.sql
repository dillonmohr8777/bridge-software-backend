-- Provider calls disclose a full EIN and may be billable. Bind every request
-- to one encrypted intake version, serialize starts, and keep provider output
-- as evidence for the existing platform-admin review flow.

alter table public.business_ein_secrets
add column secret_version uuid not null default gen_random_uuid();

alter table public.ein_verifications
add column ein_secret_version uuid;

create unique index ein_verifications_one_open_attempt
on public.ein_verifications(verification_item_id)
where completed_at is null;

create function public.guard_ein_secret_replacement_during_verification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if exists (
        select 1 from public.ein_verifications ev
        join public.verification_items vi on vi.id = ev.verification_item_id
        join public.verification_cases vc on vc.id = vi.verification_case_id
        where vc.business_id = old.business_id and ev.completed_at is null
    ) then
        raise object_not_in_prerequisite_state using
            message = 'EIN cannot be replaced while provider verification is in progress.';
    end if;
    new.secret_version := gen_random_uuid();
    return new;
end;
$$;

revoke all on function public.guard_ein_secret_replacement_during_verification()
from public, anon, authenticated;
create trigger business_ein_secret_guard_active_verification
before update on public.business_ein_secrets
for each row execute function public.guard_ein_secret_replacement_during_verification();

create function public.guard_ein_review_until_provider_complete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.item_type = 'ein'::public.verification_item_type
       and new.status in ('verified', 'rejected', 'correction_required')
       and exists (
           select 1 from public.ein_verifications ev
           where ev.verification_item_id = new.id and ev.completed_at is null
       ) then
        raise object_not_in_prerequisite_state using
            message = 'EIN provider verification is still in progress.';
    end if;
    if new.item_type = 'ein'::public.verification_item_type
       and new.status = 'verified'::public.verification_item_status
       and not exists (
           select 1
           from public.ein_verifications ev
           join public.verification_cases vc on vc.id = new.verification_case_id
           join public.business_ein_secrets bes on bes.business_id = vc.business_id
           where ev.verification_item_id = new.id
             and ev.completed_at is not null
             and ev.result_status = 'verified'
             and ev.ein_secret_version = bes.secret_version
       ) then
        raise object_not_in_prerequisite_state using
            message = 'Current EIN intake has no verified provider evidence.';
    end if;
    return new;
end;
$$;

revoke all on function public.guard_ein_review_until_provider_complete()
from public, anon, authenticated;
create trigger verification_item_guard_active_ein_provider
before update of status on public.verification_items
for each row execute function public.guard_ein_review_until_provider_complete();

drop function public.get_ein_secret_for_verification(uuid, uuid);

create function public.get_ein_secret_for_verification(
    p_actor_user_id uuid,
    p_verification_item_id uuid
)
returns table (
    business_id uuid,
    legal_name text,
    ein_last_four text,
    ciphertext text,
    iv text,
    auth_tag text,
    key_version integer,
    secret_version uuid
)
language plpgsql security definer set search_path = '' as $$
begin
    if p_actor_user_id is null or not exists (
        select 1 from auth.users u where u.id = p_actor_user_id
    ) then
        raise insufficient_privilege using message = 'A valid actor is required.';
    end if;
    if not exists (
        select 1 from public.user_platform_roles upr
        where upr.user_id = p_actor_user_id and upr.role = 'admin'::public.platform_role
    ) then
        raise insufficient_privilege using message = 'Platform administrator permission is required.';
    end if;

    return query
    select b.id, b.legal_name, b.ein_last_four, bes.ciphertext, bes.iv,
           bes.auth_tag, bes.key_version, bes.secret_version
    from public.verification_items vi
    join public.verification_cases vc on vc.id = vi.verification_case_id
    join public.businesses b on b.id = vc.business_id
    join public.business_ein_secrets bes on bes.business_id = b.id
    where vi.id = p_verification_item_id
      and vi.item_type = 'ein'::public.verification_item_type
      and b.organization_id = vc.organization_id;
    if not found then
        raise no_data_found using message = 'Encrypted EIN verification item not found.';
    end if;
end;
$$;

drop function public.request_ein_verification(uuid, text, text);

create function public.request_ein_verification(
    p_verification_item_id uuid,
    p_ein_last_four text,
    p_provider text,
    p_ein_secret_version uuid
)
returns table (
    ein_verification_id uuid,
    organization_id uuid,
    business_id uuid,
    legal_name text,
    verification_item_id uuid
)
language plpgsql security definer set search_path = '' as $$
declare
    actor_id uuid := auth.uid();
    target_organization_id uuid;
    target_business_id uuid;
    target_legal_name text;
    stored_ein_last_four text;
    stored_secret_version uuid;
    previous_item_status public.verification_item_status;
    attempt_id uuid;
begin
    if actor_id is null then
        raise insufficient_privilege using message = 'Authentication is required.';
    end if;
    if not exists (
        select 1 from public.user_platform_roles upr
        where upr.user_id = actor_id and upr.role = 'admin'::public.platform_role
    ) then
        raise insufficient_privilege using message = 'Platform administrator permission is required.';
    end if;
    if p_provider is null or btrim(p_provider) = '' then
        raise invalid_parameter_value using message = 'A provider is required.';
    end if;

    select vc.organization_id, vc.business_id
    into target_organization_id, target_business_id
    from public.verification_items vi
    join public.verification_cases vc on vc.id = vi.verification_case_id
    join public.businesses b on b.id = vc.business_id
    where vi.id = p_verification_item_id
      and vi.item_type = 'ein'::public.verification_item_type
      and b.organization_id = vc.organization_id;
    if target_organization_id is null then
        raise no_data_found using message = 'EIN verification item not found.';
    end if;

    -- Intake locks this same business row before replacing the secret.
    perform 1 from public.businesses b
    where b.id = target_business_id and b.organization_id = target_organization_id
    for update;

    select b.legal_name, b.ein_last_four, bes.secret_version, vi.status
    into target_legal_name, stored_ein_last_four, stored_secret_version, previous_item_status
    from public.verification_items vi
    join public.verification_cases vc on vc.id = vi.verification_case_id
    join public.businesses b on b.id = vc.business_id
    join public.business_ein_secrets bes on bes.business_id = b.id
    where vi.id = p_verification_item_id and b.id = target_business_id
    for update of vi;
    if target_legal_name is null then
        raise no_data_found using message = 'Encrypted EIN not found.';
    end if;

    if previous_item_status not in ('pending', 'in_review', 'rejected', 'correction_required')
       or exists (
           select 1 from public.ein_verifications ev
           where ev.verification_item_id = p_verification_item_id and ev.completed_at is null
       ) then
        raise object_not_in_prerequisite_state using
            message = 'EIN verification cannot start from the current item state.';
    end if;
    if p_ein_last_four is null or stored_ein_last_four is null
       or stored_ein_last_four <> p_ein_last_four
       or p_ein_secret_version is null or stored_secret_version <> p_ein_secret_version then
        raise object_not_in_prerequisite_state using
            message = 'EIN intake changed before verification started.';
    end if;

    insert into public.ein_verifications (
        verification_item_id, provider, requested_by_user_id,
        result_status, ein_secret_version
    ) values (
        p_verification_item_id, lower(btrim(p_provider)), actor_id,
        'requested', p_ein_secret_version
    ) returning id into attempt_id;

    update public.verification_items
    set status = 'verification_requested'::public.verification_item_status,
        verification_method = 'api'::public.verification_method
    where id = p_verification_item_id;

    insert into public.verification_item_history (
        verification_item_id, previous_status, new_status, action, actor_user_id
    ) values (
        p_verification_item_id, previous_item_status,
        'verification_requested'::public.verification_item_status,
        'verification_requested'::public.verification_history_action, actor_id
    );

    insert into public.audit_logs (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        target_organization_id, actor_id,
        'verification_requested'::public.audit_action,
        'ein_verification', attempt_id,
        jsonb_build_object(
            'verification_item_id', p_verification_item_id,
            'provider', lower(btrim(p_provider)),
            'ein_secret_version', p_ein_secret_version
        )
    );

    return query select attempt_id, target_organization_id, target_business_id,
                        target_legal_name, p_verification_item_id;
end;
$$;

create function public.complete_ein_provider_evidence(
    p_ein_verification_id uuid,
    p_provider_reference text,
    p_result_status text,
    p_result_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
    target_organization_id uuid;
    target_item_id uuid;
    actor_id uuid;
begin
    if p_result_status not in ('verified', 'rejected', 'correction_required', 'provider_error') then
        raise invalid_parameter_value using message = 'Invalid provider evidence status.';
    end if;

    select vc.organization_id, vi.id, ev.requested_by_user_id
    into target_organization_id, target_item_id, actor_id
    from public.ein_verifications ev
    join public.verification_items vi on vi.id = ev.verification_item_id
    join public.verification_cases vc on vc.id = vi.verification_case_id
    where ev.id = p_ein_verification_id
    for update of ev;
    if target_item_id is null then
        raise no_data_found using message = 'EIN verification attempt not found.';
    end if;
    if exists (
        select 1 from public.ein_verifications ev
        where ev.id = p_ein_verification_id and ev.completed_at is not null
    ) then
        raise object_not_in_prerequisite_state using
            message = 'EIN verification attempt is already complete.';
    end if;

    update public.ein_verifications
    set provider_reference = p_provider_reference,
        completed_at = timezone('utc', now()),
        result_status = p_result_status,
        result_reason = p_result_reason
    where id = p_ein_verification_id;

    insert into public.audit_logs (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        target_organization_id, actor_id,
        'verification_completed'::public.audit_action,
        'ein_verification', p_ein_verification_id,
        jsonb_build_object(
            'verification_item_id', target_item_id,
            'result_status', p_result_status,
            'source', 'provider_evidence'
        )
    );
end;
$$;

create function public.abandon_ein_provider_attempt(
    p_actor_user_id uuid,
    p_ein_verification_id uuid,
    p_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
    target_organization_id uuid;
    target_item_id uuid;
    normalized_reason text := nullif(btrim(p_reason), '');
begin
    if p_actor_user_id is null or not exists (
        select 1 from auth.users u where u.id = p_actor_user_id
    ) or not exists (
        select 1 from public.user_platform_roles upr
        where upr.user_id = p_actor_user_id
          and upr.role = 'admin'::public.platform_role
    ) then
        raise insufficient_privilege using message = 'Platform administrator permission is required.';
    end if;
    if normalized_reason is null then
        raise invalid_parameter_value using message = 'A recovery reason is required.';
    end if;

    select vc.organization_id, vi.id
    into target_organization_id, target_item_id
    from public.ein_verifications ev
    join public.verification_items vi on vi.id = ev.verification_item_id
    join public.verification_cases vc on vc.id = vi.verification_case_id
    where ev.id = p_ein_verification_id
    for update of ev;
    if target_item_id is null then
        raise no_data_found using message = 'EIN verification attempt not found.';
    end if;
    if exists (
        select 1 from public.ein_verifications ev
        where ev.id = p_ein_verification_id and ev.completed_at is not null
    ) then
        raise object_not_in_prerequisite_state using
            message = 'EIN verification attempt is already complete.';
    end if;

    update public.ein_verifications
    set completed_at = timezone('utc', now()),
        result_status = 'abandoned',
        result_reason = normalized_reason
    where id = p_ein_verification_id;

    insert into public.audit_logs (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        target_organization_id, p_actor_user_id,
        'verification_completed'::public.audit_action,
        'ein_verification', p_ein_verification_id,
        jsonb_build_object(
            'verification_item_id', target_item_id,
            'result_status', 'abandoned',
            'reason', normalized_reason,
            'source', 'admin_recovery'
        )
    );
end;
$$;

revoke all on function public.get_ein_secret_for_verification(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.get_ein_secret_for_verification(uuid, uuid) to service_role;
revoke all on function public.request_ein_verification(uuid, text, text, uuid)
from public, anon;
grant execute on function public.request_ein_verification(uuid, text, text, uuid) to authenticated;
revoke all on function public.complete_ein_provider_evidence(uuid, text, text, text)
from public, anon, authenticated;
grant execute on function public.complete_ein_provider_evidence(uuid, text, text, text) to service_role;
revoke all on function public.abandon_ein_provider_attempt(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.abandon_ein_provider_attempt(uuid, uuid, text) to service_role;
revoke all on function public.complete_ein_verification(
    uuid, text, text, text, public.verification_item_status
) from service_role;

comment on function public.get_ein_secret_for_verification(uuid, uuid) is
    'Service-role-only encrypted EIN retrieval after independent platform-admin authorization.';
comment on function public.request_ein_verification(uuid, text, text, uuid) is
    'Platform-admin-only, version-bound and row-locked provider request creation.';
comment on function public.complete_ein_provider_evidence(uuid, text, text, text) is
    'Records provider evidence without changing trusted verification item review state.';
comment on function public.abandon_ein_provider_attempt(uuid, uuid, text) is
    'Audited platform-admin recovery for an interrupted provider call; never retries or verifies.';

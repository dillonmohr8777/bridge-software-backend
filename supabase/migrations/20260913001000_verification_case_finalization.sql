-- Complete a case only from the same trusted admin audit written by the review RPC.
create function public.finalize_verification_case_after_item_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_case_id uuid;
    finalized boolean;
begin
    if new.entity_type <> 'verification_item'
       or new.action <> 'approve'::public.audit_action
       or new.metadata->>'new_status' <> 'verified'
       or not exists (
           select 1 from public.user_platform_roles pr
           where pr.user_id = new.actor_user_id
             and pr.role = 'admin'::public.platform_role
       ) then
        return new;
    end if;

    select vc.id into target_case_id
    from public.verification_cases vc
    where vc.id::text = new.metadata->>'verification_case_id'
      and vc.organization_id = new.organization_id
    for update of vc;

    if target_case_id is null then
        return new;
    end if;

    update public.verification_cases vc
    set status = 'approved',
        started_review_at = coalesce(vc.started_review_at, timezone('utc', now())),
        completed_at = timezone('utc', now()),
        assigned_admin_user_id = coalesce(vc.assigned_admin_user_id, new.actor_user_id)
    where vc.id = target_case_id
      and vc.status in ('draft', 'submitted', 'in_review', 'action_required')
      and (
          select count(distinct vi.item_type) = 2
          from public.verification_items vi
          join public.user_platform_roles pr
            on pr.user_id = vi.reviewed_by_user_id
           and pr.role = 'admin'::public.platform_role
          where vi.verification_case_id = vc.id
            and vi.item_type in ('ein', 'cannabis_license')
            and vi.status = 'verified'
            and vi.reviewed_at is not null
            and (
                select h.new_status = 'verified'
                   and h.actor_user_id = vi.reviewed_by_user_id
                from public.verification_item_history h
                where h.verification_item_id = vi.id
                order by h.created_at desc, h.id desc
                limit 1
            )
            and exists (
                select 1 from public.audit_logs a
                where a.entity_type = 'verification_item'
                  and a.entity_id = vi.id
                  and a.organization_id = vc.organization_id
                  and a.actor_user_id = vi.reviewed_by_user_id
                  and a.metadata->>'verification_case_id' = vc.id::text
                  and a.metadata->>'new_status' = 'verified'
            )
      )
    returning true into finalized;

    if finalized then
        insert into public.audit_logs (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            new.organization_id,
            new.actor_user_id,
            'approve',
            'verification_case',
            target_case_id,
            jsonb_build_object('source', 'required_items_verified')
        );
    end if;

    return new;
end;
$$;

revoke all on function public.finalize_verification_case_after_item_review()
from public, anon, authenticated;

create trigger verification_case_finalize_after_item_review
after insert on public.audit_logs
for each row execute function public.finalize_verification_case_after_item_review();

comment on function public.finalize_verification_case_after_item_review() is
    'Atomically approves a case when the trusted admin review path verifies both required business items.';

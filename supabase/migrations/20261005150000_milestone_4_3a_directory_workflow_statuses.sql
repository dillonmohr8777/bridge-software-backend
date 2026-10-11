-- ============================================================================
-- BRIDGE — MILESTONE 4.3A
-- Directory workflow status extensions
--
-- Kept separate so the enum additions commit before later migrations use the
-- new values in functions and constraints.
-- ============================================================================

alter type public.directory_profile_status
    add value if not exists 'correction_requested';

alter type public.directory_profile_status
    add value if not exists 'rejected';

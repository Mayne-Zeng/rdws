-- Custom SQL migration file, put your code below! --
WITH added AS (
  INSERT INTO requirement_participant(requirement_id,user_id,role)
  SELECT r.id,r.lead_id,'developer' FROM requirement r
  WHERE EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id=r.project_id AND pm.user_id=r.lead_id AND pm.role='developer')
  ON CONFLICT DO NOTHING RETURNING requirement_id
), advanced AS (
  UPDATE requirement r SET context_version=context_version+1
  WHERE r.id IN (SELECT requirement_id FROM added)
  RETURNING r.id,r.context_version
)
INSERT INTO requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,after)
SELECT 'migration-0003-'||id,id,'requirement.participation.repaired','migration','migration','migration-0003',context_version,jsonb_build_object('role','developer') FROM advanced;

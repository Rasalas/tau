export const PROJECT_APPROVAL_EVENT = "project-approval";
export const PROJECT_APPROVAL_COMMAND = "approve-project-setup";

export interface ProjectApprovalRequest {
  id: string;
  project: string;
  commands: string[];
}

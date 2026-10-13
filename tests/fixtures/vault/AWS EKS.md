IRSA (IAM Roles for Service Accounts) is how workloads on EKS get AWS credentials without node-wide permissions.

## How it works

- The cluster has an OIDC provider registered with IAM.
- A Kubernetes service account is annotated with a role ARN.
- With IRSA, a pod assumes an IAM role by exchanging its projected service account token through `sts:AssumeRoleWithWebIdentity`.

## Things to check

- The role's trust policy must name the cluster's OIDC provider and the service account.
- The `eks.amazonaws.com/role-arn` annotation must match the role exactly.
- Restart the pod after changing the annotation; the token is mounted when the pod starts.

Plan for moving the platform clusters from IRSA to EKS Pod Identity.

## Steps

1. Install the Pod Identity Agent add-on on every cluster.
2. Change each role's trust policy to allow `pods.eks.amazonaws.com`.
3. Create Pod Identity associations for each service account, one namespace at a time.
4. Remove the old role annotations once the workloads pick up the new credentials.

## Risks

- Workloads on old AWS SDK versions do not know the new credential provider.
- Cross-account roles need role chaining set up separately.

An IAM role has two kinds of policy attached, and they answer different questions.

- The trust policy says who can assume the role.
- The permissions policies say what the role can do once it has been assumed.

## Trust policy notes

- The `Principal` element names an account, a service, or a federated identity provider.
- Add a `Condition` on `sts:ExternalId` when a third party assumes the role.
- For OIDC federation, restrict the `sub` claim, or any identity from the provider can get in.
- A trust policy is a resource policy: it lives on the role, not on the caller.

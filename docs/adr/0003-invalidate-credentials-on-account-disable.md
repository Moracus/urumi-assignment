# Invalidate credentials when disabling an account

Disabling a user permanently invalidates existing dashboard sessions and revokes existing gateway API keys, rather than temporarily suspending those credentials. Re-enabling allows fresh login and key issuance, so potentially compromised credentials cannot silently regain access; password changes and administrator password resets invalidate dashboard sessions but leave API keys valid until separately revoked.

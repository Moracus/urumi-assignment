# Consume initial administrator setup permanently

Initial administrator setup is permanently consumed after its first successful completion, rather than becoming available whenever no administrator is found. This prevents account changes or database lookup failures from reopening enrollment; recovery instead requires a separate operator-only CLI procedure and never restores bootstrap bearer authentication.

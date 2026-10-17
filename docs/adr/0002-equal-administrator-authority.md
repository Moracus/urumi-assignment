# Give administrators equal authority

Every administrator may promote members, demote administrators, and disable administrators, rather than introducing a privileged owner role. User creation produces members and promotion is a separate explicit action; an atomic last-active-administrator invariant prevents concurrent changes from leaving the gateway without an active administrator.

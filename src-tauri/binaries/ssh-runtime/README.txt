Linux helper packages use the distribution OpenSSH client through staged wrappers.

macOS and Windows helper builds may populate this directory with runtime libraries
required by their managed OpenSSH binaries. This tracked file keeps the Tauri resource
glob valid in clean release checkouts.

# claude-rc

Auto-starts Claude Code Remote Control after boot (tmux session `claude`,
permission mode `bypassPermissions`), so the server is reachable from
claude.ai/code and the Claude app without logging in.

Install (user service + linger so it runs without login):

    cp claude-rc.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable claude-rc.service
    sudo loginctl enable-linger sparrow

Attach locally: `tmux attach -t claude`.

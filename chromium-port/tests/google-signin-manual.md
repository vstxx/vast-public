# Manual clean-profile website sign-in checklist

Use a development build only. Do not record credentials, cookies, screenshots containing account data, or profile files in Git.

1. Launch `Vast.exe` with a new empty `--user-data-dir` below `%TEMP%` and without `--no-sandbox`, `--disable-web-security`, certificate overrides, UA overrides, or automation flags.
2. Confirm the About/version surface identifies Chromium/Vast and does not claim Google Chrome or Chrome Sync.
3. Open `https://accounts.google.com` in a normal top-level tab (not WebUI, iframe, webview, popup wrapper, or external browser).
4. Manually complete ordinary Google website sign-in. Never put credentials into an automated test.
5. In new normal tabs load Gmail, YouTube, and Google Calendar. Confirm the website session is recognized.
6. Close all Vast windows normally, relaunch with the same test profile, and confirm the website session persists.
7. Sign out through Google's website, close Vast, and securely remove only this temporary test profile.

Pass means website authentication works. The absence of a Chromium/Chrome profile avatar, browser-level Google sign-in, or Chrome Sync is expected and is not a failure.

Record only: build report ID/SHA-256, test date, Windows version, pass/fail per site, and sanitized error text.

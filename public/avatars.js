(function () {
    const PASTEL_PALETTE = [
        { bg: '#DCEEFB', fg: '#1E4D78' },
        { bg: '#F8DCE8', fg: '#8B3A62' },
        { bg: '#D5F0E8', fg: '#1F5C4A' },
        { bg: '#E8E0F5', fg: '#4A3B78' },
        { bg: '#FBE4D5', fg: '#8B4A2A' },
        { bg: '#D8E8F5', fg: '#2A5278' },
        { bg: '#E5F0D5', fg: '#3D6B2E' },
        { bg: '#F5DCE8', fg: '#7A3A58' },
        { bg: '#D5EBF0', fg: '#2A6670' },
        { bg: '#EDE0F0', fg: '#5A4578' },
        { bg: '#F0E8D8', fg: '#6B5430' },
        { bg: '#DCE8F5', fg: '#3A5A78' }
    ];

    function hashString(str) {
        let h = 0;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h) + s.charCodeAt(i);
            h |= 0;
        }
        return Math.abs(h);
    }

    /** Первые две буквы никнейма: «Artem» → «AR», «кот» → «КО». */
    function getInitialsFromNickname(name) {
        const chars = Array.from(String(name || '').trim());
        if (!chars.length) return '?';
        return (chars[0] + (chars[1] || '')).toUpperCase();
    }

    function getInitialsFromFio(name) {
        return getInitialsFromNickname(name);
    }

    function getAvatarPastel(name) {
        const idx = hashString(name) % PASTEL_PALETTE.length;
        return PASTEL_PALETTE[idx];
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** На карточке показываем никнейм как есть. */
    function formatCardDisplayName(name) {
        return String(name || '').trim();
    }

    function renderUserAvatar(name, size) {
        const sz = size || 'md';
        const initials = getInitialsFromNickname(name);
        const { bg, fg } = getAvatarPastel(name);
        const title = escapeHtml(name);
        return `<span class="user-avatar user-avatar-${sz}" style="--avatar-bg:${bg};--avatar-fg:${fg}" title="${title}" aria-hidden="true">${escapeHtml(initials)}</span>`;
    }

    function renderUserAvatarWithName(name, size, useShortLabel) {
        const n = String(name || '').trim();
        if (!n) return '';
        const label = useShortLabel ? formatCardDisplayName(n) : n;
        const fullTitle = escapeHtml(n);
        return `<span class="user-avatar-wrap" title="${fullTitle}">${renderUserAvatar(n, size || 'sm')}<span class="user-avatar-name">${escapeHtml(label)}</span></span>`;
    }

    window.getInitialsFromNickname = getInitialsFromNickname;
    window.getInitialsFromFio = getInitialsFromFio;
    window.getAvatarPastel = getAvatarPastel;
    window.formatCardDisplayName = formatCardDisplayName;
    window.renderUserAvatar = renderUserAvatar;
    window.renderUserAvatarWithName = renderUserAvatarWithName;
})();

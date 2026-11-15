const API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = "LuniBot@Archiver/1 (https://en.wikipedia.org/wiki/User:LuniBot)";

const cookies = new Map();

const mw = (async function(params) {
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT };
    if (cookies.size) headers["Cookie"] = Array.from(cookies).map(([ k, v ]) => `${k}=${v}`).join("; ");

    const res = await fetch(API, {
        method: "POST",
        headers,
        body: new URLSearchParams({
            format: "json",
            formatversion: "2",
            ...params
        })
    });

    for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0], i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }

    return res.json();
});

const months = [ "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" ];
const parse_section = (function(codepoints) {
    const text = codepoints.join("");
    const timestamps = Array.from(text.matchAll(this.regex)).map(([ timestamp, hour, minute, day, month, year ]) => {
        const monthNumber = String(months.indexOf(month) + 1).padStart(2, "0");
        return new Date(`${year}-${monthNumber}-${day.padStart(2, "0")}T${hour}:${minute}:00Z`);
    }).sort((a, b) => a - b);
    return { text, date: { oldest: timestamps[0], newest: timestamps.at(-1) } };
}).bind({
    regex: /(?<=\s)(\d{2}):(\d{2}), (\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}) \(UTC\)/g
});

const run = (async function(user) {
    const archiveDate = new Date();

    const tokens = (await mw({ action: "query", meta: "tokens" })).query.tokens;

    const pages = (await mw({
        "action": "query",
        "prop": "revisions",
        "titles": `User:${user}/ArchiveLength|User talk:${user}`,
        "rvprop": "content",
        "rvslots": "*"
    })).query.pages;

    let talk;
    for (const page of pages) {
        const content = page.revisions[0].slots.main.content;
        switch (page.title) {
            case `User:${user}/ArchiveLength`: {
                const tokens = content.split("/")[0].split(" ");
                const n = Number.parseInt(tokens[0]) || 1;
                switch (tokens[1].toLowerCase()) {
                    case "hours": case "hour": {
                        archiveDate.setUTCHours(archiveDate.getUTCHours() - n);
                    } break;
                    case "days": case "day": {
                        archiveDate.setUTCDate(archiveDate.getUTCDate() - n);
                    } break;
                    case "weeks": case "week": {
                        archiveDate.setUTCDate(archiveDate.getUTCDate() - n * 7);
                    } break;
                    case "months": case "month": {
                        archiveDate.setUTCMonth(archiveDate.getUTCMonth() - n);
                    } break;
                    case "years": case "year": {
                        archiveDate.setUTCFullYear(archiveDate.getUTCFullYear() - n);
                    } break;
                }
            } break;
            case `User talk:${user}`: {
                talk = Array.from(content);
            } break;
        }
    }

    const parsed = (await mw({
        "action": "parse",
        "page": `User talk:${user}`,
        "disablelimitreport": 1,
        "disableeditsection": 1,
        "disablestylededuplication": 1,
        "disabletoc": 1,
    })).parse;

    let start = "", offset;
    const sections = [ ];
    for (const section of parsed.tocdata.sections)
        if (section.hLevel === 2) {
            const temp = section.codepointOffset;
            if (offset !== undefined) sections.push(parse_section(talk.slice(offset, temp)));
            else start = talk.slice(0, temp);
            offset = temp;
        }
    if (offset !== undefined) sections.push(parse_section(talk.slice(offset)));
    else start = talk;

    const archives = new Map();
    const filtered = sections.filter(section => {
        if (section.date.newest <= archiveDate) {
            const archive = `${section.date.oldest.getUTCFullYear()}/${months[section.date.oldest.getUTCMonth()]}`;
            if (!archives.has(archive))
                archives.set(archive, [ section ]);
            else
                archives.get(archive).push(section);

            return false;
        }

        return true;
    });

    const amount = sections.length - filtered.length;
    if (amount > 0) {
        const pages = Array.from(archives.keys()).map(key => `[[User talk:${user}/Archive/${key}]]`);
        let pagesText = "";
        switch (pages.length) {
            case 1: {
                pagesText = pages[0];
            } break;
            default: {
                const length = pages.length - 1;
                for (let i = 0; i < length; i++)
                    pagesText += `${pages[i]}, `;
                pagesText += `and ${pages[length]}`;
            } break;
        }

        mw({
            "action": "edit",
            "title": `User talk:${user}`,
            "summary": `Archiving ${amount} discussion${amount > 1 ? "s" : ""} to ${pagesText}) (bot`,
            "text": filtered.reduce((acc, section) => `${acc}${section.text}`, start.join("")),
            "token": tokens.csrftoken,
        });
    }

    for (const key of archives.keys()) {
        const page = `User talk:${user}/Archive/${key}`;

        const wt = Array.from((await mw({
            "action": "query",
            "prop": "revisions",
            "titles": page,
            "rvprop": "content",
            "rvslots": "*"
        })).query.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? "");
        const parsed = (await mw({
            "action": "parse",
            "page": page,
            "disablelimitreport": 1,
            "disableeditsection": 1,
            "disablestylededuplication": 1,
            "disabletoc": 1,
        })).parse ?? { tocdata: { sections: [ ] } };

        let offset;
        const archiveSections = [ ];
        for (const section of parsed.tocdata.sections)
            if (section.hLevel === 2) {
                const temp = section.codepointOffset;
                if (offset !== undefined) archiveSections.push(parse_section(wt.slice(offset, temp)));
                offset = temp;
            }
        if (offset !== undefined) archiveSections.push(parse_section(wt.slice(offset)));
        archiveSections.sort((a, b) => a.date.oldest - b.date.oldest);

        const sections = archives.get(key);
        for (const section of sections) {
            const oldest = section.date.oldest;
            const length = archiveSections.length;
            for (let i = 0; i <= length; i++)
                if (oldest < (archiveSections[i]?.date?.oldest ?? Infinity)) {
                    archiveSections.splice(i, 0, section);
                    break;
                }
        }

        mw({
            "action": "edit",
            "title": page,
            "summary": `Archiving ${sections.length} discussion${sections.length > 1 ? "s" : ""} from [[User talk:${user}]]) (bot`,
            "text": archiveSections.reduce((acc, archiveSection) => `${acc}\n${archiveSection.text.trim()}\n`, `{{User:LuniZunie/ArchiveHeader|page={{#titleparts:{{PAGENAME}}|-3}}}}`).trim(),
            "token": tokens.csrftoken,
        });
    }
});

const execute = (async function() {
    await mw({
        action: "login",
        lgname: process.env.USERNAME,
        lgpassword: process.env.PASSWORD,
        lgtoken: (await mw({ action: "query", meta: "tokens", type: "login" })).query.tokens.logintoken
    });

    await run("LuniZunie");
    await run("LuniZunie/Subscriptions");
    await run("LuniZunie-Mentor");
});

const schedule = (function(first) {
    setTimeout(async () => {
        try {
            await execute();
        } catch (error) {
            console.error(error);
        } finally {
            schedule(false);
        }
    }, first ? 0 : 3_600_000 - (Date.now() % 3_600_000));
});
schedule(true);
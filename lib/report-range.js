const REPORT_CUTOFF_HOUR = 6;
const REPORT_TIME_ZONE = "Asia/Seoul";
const KST_OFFSET = "+09:00";
const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateTime(date, timeZone = REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function formatLogicalDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseEnvDate(input, kind) {
  const trimmed = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const cutoff = String(REPORT_CUTOFF_HOUR).padStart(2, "0");
    const beforeCutoff = String(REPORT_CUTOFF_HOUR - 1).padStart(2, "0");
    const suffix = kind === "start"
      ? `T${cutoff}:00:00`
      : `T${beforeCutoff}:59:59.999`;
    const date = new Date(trimmed + suffix + KST_OFFSET);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind === "start" ? "START_DATE" : "END_DATE"}: ${input}`);
    }
    return date;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+\-]\d{2}:?\d{2})?$/.test(trimmed)) {
    const hasTimeZone = /(Z|[+\-]\d{2}:?\d{2})$/.test(trimmed);
    const date = new Date(hasTimeZone ? trimmed : trimmed + KST_OFFSET);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind === "start" ? "START_DATE" : "END_DATE"}: ${input}`);
    }
    return date;
  }

  throw new Error(
    `Invalid ${kind === "start" ? "START_DATE" : "END_DATE"} format: ${input}. ` +
    "Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS"
  );
}

function dateRange(meetingDate, env = process.env) {
  const envStart = env.START_DATE;
  const envEnd = env.END_DATE;
  let start;
  let end;
  let overridden = false;

  if (envStart && envEnd) {
    start = parseEnvDate(envStart, "start");
    end = parseEnvDate(envEnd, "end");
    overridden = true;
  } else {
    if (envStart || envEnd) {
      console.warn(
        "[dateRange] START_DATE / END_DATE 는 둘 다 지정해야 적용됩니다. 자동 계산을 사용합니다."
      );
    }
    const cutoff = String(REPORT_CUTOFF_HOUR).padStart(2, "0");
    const boundary = new Date(
      `${formatLogicalDate(meetingDate)}T${cutoff}:00:00.000${KST_OFFSET}`
    );
    start = new Date(boundary.getTime() - 7 * DAY_MS);
    end = new Date(boundary.getTime() - 1);
  }

  if (start > end) {
    throw new Error("START_DATE must not be later than END_DATE");
  }

  if (overridden) {
    console.log(`[dateRange] override by env: ${formatDateTime(start)} ~ ${formatDateTime(end)}`);
  }

  const endExclusive = new Date(end.getTime() + 1);
  return {
    startDate: formatDateTime(start),
    endDate: formatDateTime(end),
    startInclusive: start.toISOString(),
    endExclusive: endExclusive.toISOString(),
    start,
    end,
  };
}

function isWithinRange(timestamp, range) {
  if (!timestamp) return false;
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return false;
  return time >= range.start.getTime() && time <= range.end.getTime();
}

module.exports = {
  REPORT_CUTOFF_HOUR,
  REPORT_TIME_ZONE,
  dateRange,
  formatDateTime,
  isWithinRange,
  parseEnvDate,
};

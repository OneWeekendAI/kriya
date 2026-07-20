import { useEffect, useRef, useState } from "react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function DatePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (val: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse initial date or fallback to today
  const initialDate = value ? new Date(value + "T00:00:00") : new Date();
  const [viewYear, setViewYear] = useState(initialDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialDate.getMonth());

  // Reset view when value changes and popover is closed
  useEffect(() => {
    if (!open && value) {
      const d = new Date(value + "T00:00:00");
      if (!isNaN(d.getTime())) {
        setViewYear(d.getFullYear());
        setViewMonth(d.getMonth());
      }
    }
  }, [value, open]);

  // Handle outside clicks to close popover
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  // Navigate months
  function prevMonth() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  }

  // Generate calendar grid (42 cells)
  const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
  const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthTotalDays = new Date(viewYear, viewMonth, 0).getDate();

  const cells: { day: number; dateStr: string; isCurrentMonth: boolean }[] = [];

  // Previous month dates
  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const dayNum = prevMonthTotalDays - i;
    const prevMonthIdx = viewMonth === 0 ? 11 : viewMonth - 1;
    const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
    const dStr = `${prevYear}-${String(prevMonthIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    cells.push({ day: dayNum, dateStr: dStr, isCurrentMonth: false });
  }

  // Current month dates
  for (let i = 1; i <= totalDays; i++) {
    const dStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
    cells.push({ day: i, dateStr: dStr, isCurrentMonth: true });
  }

  // Next month dates
  const remaining = 42 - cells.length;
  for (let i = 1; i <= remaining; i++) {
    const nextMonthIdx = viewMonth === 11 ? 0 : viewMonth + 1;
    const nextYear = viewMonth === 11 ? viewYear + 1 : viewYear;
    const dStr = `${nextYear}-${String(nextMonthIdx + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
    cells.push({ day: i, dateStr: dStr, isCurrentMonth: false });
  }

  // Format displaying value on the button
  const displayVal = () => {
    if (!value) return "dd/mm/yyyy";
    const d = new Date(value + "T00:00:00");
    if (isNaN(d.getTime())) return value;
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  };

  const todayStr = toISODate(new Date());

  return (
    <div className="kriya-datepicker" ref={containerRef}>
      <button
        type="button"
        className="kriya-datepicker-trigger"
        onClick={() => setOpen(!open)}
      >
        {displayVal()}
      </button>

      {open && (
        <div className="kriya-datepicker-popover">
          <div className="kriya-datepicker-header">
            <span className="kriya-datepicker-month-year">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <div className="kriya-datepicker-nav">
              <button type="button" className="kriya-datepicker-nav-btn" onClick={prevMonth} title="Previous Month">
                ↑
              </button>
              <button type="button" className="kriya-datepicker-nav-btn" onClick={nextMonth} title="Next Month">
                ↓
              </button>
            </div>
          </div>

          <div className="kriya-datepicker-weekdays">
            {WEEKDAYS.map((w, idx) => (
              <span key={idx}>{w}</span>
            ))}
          </div>

          <div className="kriya-datepicker-grid">
            {cells.map((cell, idx) => {
              const isSelected = value === cell.dateStr;
              const isToday = todayStr === cell.dateStr;
              return (
                <button
                  key={idx}
                  type="button"
                  className={`kriya-datepicker-cell${!cell.isCurrentMonth ? " is-outside" : ""}${isSelected ? " is-selected" : ""}${isToday ? " is-today" : ""}`}
                  onClick={() => {
                    onChange(cell.dateStr);
                    setOpen(false);
                  }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className="kriya-datepicker-footer">
            <button
              type="button"
              className="kriya-datepicker-footer-btn"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="kriya-datepicker-footer-btn"
              onClick={() => {
                onChange(todayStr);
                setOpen(false);
              }}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

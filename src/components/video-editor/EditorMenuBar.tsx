import { Fragment } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface EditorMenuBarProps {
  /** Whether the app is running on macOS. Drives shortcut-hint formatting. */
  isMac: boolean;
  /** Qualified-key translator (`t("common.actions.file")`). */
  t: (qualifiedKey: string) => string;
  onImportVideo: () => void;
  onExport: () => void;
  onReturnToRecorder: () => void;
  onQuit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onKeyboardShortcuts: () => void;
  onToggleTimeline: () => void;
  onToggleSettings: () => void;
  onReload: () => void;
  onSaveDiagnostics: () => void;
  onReportIssue: () => void;
  onAbout: () => void;
  canUndo: boolean;
  canRedo: boolean;
  timelineVisible: boolean;
  settingsVisible: boolean;
}

export interface EditorMenuItem {
  id: string;
  label: string;
  /** Human-readable, platform-aware shortcut hint (e.g. "Ctrl+O" / "⌘O"). */
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Renders the item in a destructive (red) style, e.g. Quit. */
  danger?: boolean;
  /** Draws a separator immediately before this item. */
  separatorBefore?: boolean;
  /** Checkbox-style state for toggles. */
  checked?: boolean;
}

export interface EditorMenu {
  id: string;
  label: string;
  minWidthClass: string;
  items: EditorMenuItem[];
}

/**
 * Formats a menu shortcut hint for the current platform. macOS uses the symbol
 * modifier with no separator ("⌘O"); everywhere else uses "Ctrl+O". These mirror
 * the accelerators wired in the native menu (electron/main.ts) and the editor
 * keydown handler, so the hints stay truthful.
 */
export function formatShortcut(isMac: boolean, key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

export function formatShiftShortcut(isMac: boolean, key: string): string {
  return isMac ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

/**
 * Pure description of the editor's File / Edit / View / Help menus. Kept
 * separate from the rendering so labels, shortcut hints, disabled states and
 * handler wiring can be unit-tested without mounting Radix.
 */
export function buildEditorMenuModel(props: EditorMenuBarProps): EditorMenu[] {
  const { isMac, t } = props;

  return [
    {
      id: "file",
      label: t("common.actions.file"),
      minWidthClass: "min-w-[190px]",
      items: [
        {
          id: "import-video",
          label: t("common.actions.importVideo"),
          shortcut: formatShortcut(isMac, "O"),
          onSelect: props.onImportVideo,
        },
        {
          id: "export",
          label: t("common.actions.export"),
          shortcut: formatShortcut(isMac, "E"),
          onSelect: props.onExport,
        },
        {
          id: "return-to-recorder",
          label: t("common.actions.returnToRecorder"),
          onSelect: props.onReturnToRecorder,
          separatorBefore: true,
        },
        {
          id: "quit",
          label: t("common.actions.quit"),
          shortcut: formatShortcut(isMac, "Q"),
          onSelect: props.onQuit,
          danger: true,
          separatorBefore: true,
        },
      ],
    },
    {
      id: "edit",
      label: t("common.actions.edit"),
      minWidthClass: "min-w-[170px]",
      items: [
        {
          id: "undo",
          label: t("common.actions.undo"),
          shortcut: formatShortcut(isMac, "Z"),
          onSelect: props.onUndo,
          disabled: !props.canUndo,
        },
        {
          id: "redo",
          label: t("common.actions.redo"),
          // Redo is bound to both Ctrl+Y and Ctrl+Shift+Z; show the
          // idiomatic hint per platform (⌘⇧Z on macOS, Ctrl+Y elsewhere).
          shortcut: isMac ? formatShiftShortcut(isMac, "Z") : formatShortcut(isMac, "Y"),
          onSelect: props.onRedo,
          disabled: !props.canRedo,
        },
        {
          id: "keyboard-shortcuts",
          label: t("common.actions.keyboardShortcuts"),
          onSelect: props.onKeyboardShortcuts,
          separatorBefore: true,
        },
      ],
    },
    {
      id: "view",
      label: t("common.actions.view"),
      minWidthClass: "min-w-[190px]",
      items: [
        {
          id: "toggle-timeline",
          label: t("common.actions.toggleTimeline"),
          shortcut: formatShiftShortcut(isMac, "T"),
          onSelect: props.onToggleTimeline,
          checked: props.timelineVisible,
        },
        {
          id: "toggle-settings",
          label: t("common.actions.toggleSettings"),
          shortcut: formatShiftShortcut(isMac, "P"),
          onSelect: props.onToggleSettings,
          checked: props.settingsVisible,
        },
        {
          id: "reload",
          label: t("common.actions.reload"),
          shortcut: formatShortcut(isMac, "R"),
          onSelect: props.onReload,
          separatorBefore: true,
        },
      ],
    },
    {
      id: "help",
      label: t("common.actions.help"),
      minWidthClass: "min-w-[170px]",
      items: [
        {
          id: "report-issue",
          label: t("common.actions.reportIssue"),
          onSelect: props.onReportIssue,
        },
        {
          id: "save-diagnostics",
          label: t("common.actions.saveDiagnostics"),
          onSelect: props.onSaveDiagnostics,
        },
        {
          id: "about",
          label: t("common.actions.about"),
          onSelect: props.onAbout,
          separatorBefore: true,
        },
      ],
    },
  ];
}

/**
 * Custom in-app menu bar (File / Edit / View / Help) shown in the editor's
 * titlebar. Replaces the native OS menu bar that is auto-hidden on
 * Windows/Linux (see electron/windows.ts); on macOS it mirrors the global bar.
 */
export function EditorMenuBar(props: EditorMenuBarProps) {
  const menus = buildEditorMenuModel(props);

  return (
    <div className={`flex items-center gap-0.5 ${props.isMac ? "ml-14" : "ml-1"}`}>
      {menus.map((menu) => (
        <DropdownMenu key={menu.id}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:bg-white/5"
            >
              {menu.label}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className={`bg-[#09090b]/95 backdrop-blur-md border border-white/[0.08] text-slate-200 ${menu.minWidthClass}`}
          >
            {menu.items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore && <DropdownMenuSeparator className="bg-white/[0.08]" />}
                <DropdownMenuItem
                  onSelect={() => item.onSelect()}
                  disabled={item.disabled}
                  className={
                    item.danger
                      ? "hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-400 text-red-400 cursor-pointer justify-between"
                      : "hover:bg-white/[0.08] focus:bg-white/[0.08] focus:text-white cursor-pointer justify-between"
                  }
                >
                  <span className="flex items-center gap-2">
                    {item.checked !== undefined && (
                      <span aria-hidden="true" className="w-3 text-[#34B27B]">
                        {item.checked ? "✓" : ""}
                      </span>
                    )}
                    {item.label}
                  </span>
                  {item.shortcut && <DropdownMenuShortcut className="ml-2">{item.shortcut}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </div>
  );
}

import { HelpCircle, Settings2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_LABEL_KEYS,
  FIXED_SHORTCUTS,
  formatBinding,
} from "@/lib/shortcuts";

export function KeyboardShortcutsHelp() {
  const { t } = useI18n();
  const { shortcuts, isMac, openConfig } = useShortcuts();

  return (
    <div className="relative group">
      <HelpCircle className="w-4 h-4 text-slate-500 hover:text-[#34B27B] transition-colors cursor-help" />
      <div className="absolute right-0 top-full mt-2 w-64 bg-[#09090b] border border-white/10 rounded-lg p-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 shadow-xl z-50">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-slate-200">{t("shortcut.title")}</div>
          <button
            onClick={(e) => { e.stopPropagation(); openConfig(); }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 text-slate-400 hover:text-[#34B27B] transition-colors text-[10px]"
            title={t("shortcut.customize")}
          >
            <Settings2 className="w-3 h-3" />
            <span>{t("shortcut.customize")}</span>
          </button>
        </div>

        {/* Configurable shortcuts */}
        <div className="space-y-1.5 text-[10px]">
          {SHORTCUT_ACTIONS.map((action) => (
            <div key={action} className="flex items-center justify-between">
              <span className="text-slate-400">{t(SHORTCUT_LABEL_KEYS[action])}</span>
              <kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded text-[#34B27B] font-mono">
                {formatBinding(shortcuts[action], isMac)}
              </kbd>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div className="my-2 border-t border-white/5" />

        {/* Fixed shortcuts */}
        <div className="space-y-1.5 text-[10px]">
          {FIXED_SHORTCUTS.map((fixed) => (
            <div key={fixed.labelKey} className="flex items-center justify-between">
              <span className="text-slate-400">{t(fixed.labelKey)}</span>
              <kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded text-[#34B27B] font-mono">
                {fixed.bindings.length > 0 ? formatBinding(fixed.bindings[0], isMac) : fixed.display}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

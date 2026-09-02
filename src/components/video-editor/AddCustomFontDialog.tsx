import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  addCustomFont,
  generateFontId,
  parseFontFamilyFromImport,
  isValidGoogleFontsUrl,
  type CustomFont,
} from '@/lib/customFonts'
import { useI18n } from '@/i18n'

interface AddCustomFontDialogProps {
  onFontAdded?: (font: CustomFont) => void
}

export function AddCustomFontDialog({ onFontAdded }: AddCustomFontDialogProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const [fontName, setFontName] = useState('')
  const [loading, setLoading] = useState(false)

  const handleImportUrlChange = (url: string) => {
    setImportUrl(url)

    // Auto-extract font name if valid Google Fonts URL
    if (isValidGoogleFontsUrl(url)) {
      const extracted = parseFontFamilyFromImport(url)
      if (extracted && !fontName) {
        setFontName(extracted)
      }
    }
  }

  const handleAdd = async () => {
    // Validate inputs
    if (!importUrl.trim()) {
      toast.error(t('settings.font.error.enterUrl'))
      return
    }

    if (!isValidGoogleFontsUrl(importUrl)) {
      toast.error(t('settings.font.error.invalidUrl'))
      return
    }

    if (!fontName.trim()) {
      toast.error(t('settings.font.error.enterName'))
      return
    }

    setLoading(true)

    try {
      // Extract font family from URL
      const fontFamily = parseFontFamilyFromImport(importUrl)
      if (!fontFamily) {
        toast.error(t('settings.font.error.extract'))
        setLoading(false)
        return
      }

      // Create custom font object
      const newFont: CustomFont = {
        id: generateFontId(fontName),
        name: fontName.trim(),
        fontFamily: fontFamily,
        importUrl: importUrl.trim(),
      }

      // Add font (this will load and verify it) - throws if it fails
      await addCustomFont(newFont)

      // Notify parent
      if (onFontAdded) {
        onFontAdded(newFont)
      }

      toast.success(t('settings.font.added', { name: fontName }))

      // Reset and close
      setImportUrl('')
      setFontName('')
      setOpen(false)
    } catch (error) {
      console.error('Failed to add custom font:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to load font'
      toast.error(t('settings.font.failed'), {
        description: errorMessage.includes('timeout')
          ? t('settings.font.failed.timeout')
          : t('settings.font.failed.generic'),
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full bg-white/5 border-white/10 text-slate-200 hover:bg-white/10 h-9 text-xs"
        >
          <Plus className="w-3 h-3 mr-1" />
          {t('settings.font.addGoogle')}
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-[#1a1a1c] border-white/10 text-slate-200">
        <DialogHeader>
          <DialogTitle>{t('settings.font.dialogTitle')}</DialogTitle>
          <DialogDescription className="text-slate-400">
            {t('settings.font.dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="import-url" className="text-slate-200">
              {t('settings.font.importUrl')}
            </Label>
            <Input
              id="import-url"
              placeholder={t('settings.font.importPlaceholder')}
              value={importUrl}
              onChange={(e) => handleImportUrlChange(e.target.value)}
              className="bg-white/5 border-white/10 text-slate-200"
            />
            <p className="text-xs text-slate-400">{t('settings.font.importHint')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="font-name" className="text-slate-200">
              {t('settings.font.displayName')}
            </Label>
            <Input
              id="font-name"
              placeholder={t('settings.font.namePlaceholder')}
              value={fontName}
              onChange={(e) => setFontName(e.target.value)}
              className="bg-white/5 border-white/10 text-slate-200"
            />
            <p className="text-xs text-slate-400">{t('settings.font.displayHint')}</p>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="bg-white/5 border-white/10 text-slate-200 hover:bg-white/10"
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {loading ? t('settings.font.adding') : t('settings.font.add')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

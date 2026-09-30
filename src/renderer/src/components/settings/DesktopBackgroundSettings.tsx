import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  resolveBackgroundMode,
  resolveBackgroundOpacity
} from '../../../../shared/desktop-background'
import { useDesktopBackground } from '../../app-shell/use-desktop-background'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { NumberField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'

export function DesktopBackgroundSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const mode = resolveBackgroundMode(settings.backgroundMode)
  const background = useDesktopBackground()
  const [restarting, setRestarting] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)
  const restartRequired = mode === 'transparent' && !background.nativeTransparency
  const desktop = document.documentElement.classList.contains('native-shell')
  const restart = async (): Promise<void> => {
    setRestarting(true)
    setRestartFailed(false)
    try {
      await window.api.app.restart()
    } catch {
      setRestarting(false)
      setRestartFailed(true)
    }
  }
  return (
    <SearchableSetting
      title={translate('settings.desktopBackground.title', 'Desktop background')}
      description={translate(
        'settings.desktopBackground.description',
        'Use the shared wallpaper, see through the window, or turn transparency off.'
      )}
      keywords={['wallpaper', 'theme', 'background', 'transparency', 'daemon']}
      className="space-y-3"
    >
      <div className="space-y-1">
        <Label htmlFor="desktop-background-mode">
          {translate('settings.desktopBackground.title', 'Desktop background')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.desktopBackground.description',
            'Use the shared wallpaper, see through the window, or turn transparency off.'
          )}
        </p>
      </div>
      <Select
        value={mode}
        disabled={!desktop}
        onValueChange={(value) => updateSettings({ backgroundMode: resolveBackgroundMode(value) })}
      >
        <SelectTrigger id="desktop-background-mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="solid">
            {translate('settings.desktopBackground.solid', 'Solid (transparency off)')}
          </SelectItem>
          <SelectItem value="image">
            {translate('settings.desktopBackground.image', 'Shared wallpaper')}
          </SelectItem>
          <SelectItem value="transparent">
            {translate('settings.desktopBackground.transparent', 'Transparent window')}
          </SelectItem>
        </SelectContent>
      </Select>
      {!desktop ? (
        <p className="text-xs text-muted-foreground">
          {translate('settings.desktopBackground.desktopOnly', 'Available in the desktop app.')}
        </p>
      ) : null}
      {mode !== 'solid' && desktop ? (
        <>
          <NumberField
            label={translate('settings.desktopBackground.opacity', 'UI background opacity')}
            description={translate(
              'settings.desktopBackground.opacityDescription',
              '0 shows the background clearly; 1 makes the UI opaque. Terminal opacity is controlled below.'
            )}
            value={resolveBackgroundOpacity(settings.backgroundOpacity)}
            defaultValue={0.78}
            min={0}
            max={1}
            step={0.05}
            suffix="0 to 1"
            onChange={(value) =>
              updateSettings({ backgroundOpacity: resolveBackgroundOpacity(value) })
            }
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.desktopBackground.daemon',
              'Follows wallpaper and transparency updates from the local theme daemon at 127.0.0.1:17321, including in SSH workspaces.'
            )}
          </p>
          {!background.enabled ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.desktopBackground.paused',
                'Transparency is off in the theme daemon. Your selected mode is preserved.'
              )}
            </p>
          ) : null}
          {background.status === 'unavailable' ? (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'settings.desktopBackground.unavailable',
                'Theme sync unavailable. Start the local theme daemon; Orca retries automatically and keeps the last wallpaper.'
              )}
            </p>
          ) : null}
          {mode === 'image' && background.status === 'connected' && !background.wallpaper ? (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'settings.desktopBackground.waiting',
                'Waiting for a JPEG, PNG or WebP wallpaper from the theme daemon.'
              )}
            </p>
          ) : null}
          {mode === 'transparent' ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.desktopBackground.platform',
                'Shows the desktop and windows behind Orca. Support depends on your window system; editors and browser pages remain opaque.'
              )}
            </p>
          ) : null}
        </>
      ) : null}
      {restartRequired && desktop ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.desktopBackground.restart',
              'Restart Orca once to enable native window transparency. Turning it off afterwards takes effect immediately.'
            )}
          </p>
          <Button size="sm" disabled={restarting} onClick={() => void restart()}>
            {translate('settings.desktopBackground.restartButton', 'Restart Orca')}
          </Button>
          {restartFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'settings.desktopBackground.restartFailed',
                'Could not restart. Quit and reopen Orca to apply the change.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </SearchableSetting>
  )
}

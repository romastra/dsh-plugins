# Резерв строки статуса / Composer status bar spacing

Нижняя панель сохраняет место процента контекста, даже когда DSH скрывает его на время записи. На широкой панели это место остаётся в той же строке, на узкой — на строке переноса. Если процент ещё не был доступен, пустая строка не добавляется. Невидимый резерв недоступен мыши и клавиатуре.

The composer keeps the space of its native context meter while DSH hides the meter during recording. It follows the existing flex wrapping rather than forcing a second line at every width. This add-on does not change the waveform, recording, the draft or the audio route. Disable it in Plugins to restore the previous spacing.

Compatibility: DSH 0.2.2-rc.5 and the native composer dock with its context anchor. The voice bundle can remain on the exact 1.2.2 release.

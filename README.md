# Last Played for Spicetify

See when you last listened to a song, directly in your Spotify playlists.

Last Played adds a **Last played** column immediately after **Date added**. It records new listening locally and imports older plays from Spotify's Extended Streaming History export.

## Features

- **Last-played timestamps:** see labels such as “Just now” or “3 days ago.”
- **Exact dates on hover:** hover over a timestamp to see its date, time, and time zone.
- **Calendar-date mode:** switch from relative times to dates in the settings.
- **30-second listening threshold:** paused time and seeking do not count as listening.
- **Historical imports:** import Spotify Extended Streaming History as JSON files or a ZIP archive.
- **Merge without losing newer plays:** importing older data keeps the newest qualifying timestamp for each track.
- **Local backups:** export your recorded timestamps and import them on another installation.
- **Account-specific storage:** different Spotify accounts use separate local databases.

The extension does not add controls to the playback bar or change your playlists, ratings, or Liked Songs.

## Requirements

- Spotify's desktop client with [Spicetify](https://spicetify.app/) installed and working.
- A playlist view with the **Date added** column visible.

No Spotify developer account, API key, or additional JavaScript libraries are required.

## Installation

1. Download `last-played.js` from this repository.
2. Put it in your Spicetify `Extensions` folder:

   | Platform | Folder |
   |---|---|
   | Windows | `%appdata%\spicetify\Extensions` |
   | macOS / Linux | `~/.config/spicetify/Extensions` |

3. Run these commands in PowerShell or your terminal:

   ```shell
   spicetify config extensions last-played.js
   spicetify apply
   ```

4. Open a playlist. The new column appears to the right of **Date added**.

Make sure the downloaded file is named `last-played.js`, without an extra `.txt` extension.

## How listening is recorded

A song qualifies after **30 seconds of observed listening during a playback session**. Opening Spotify halfway through a song does not count the time before the extension started observing it.

The extension compares playback progress with elapsed time. Pauses, forward or backward seeks, and long gaps caused by sleep or timer suspension are excluded. Listening can accumulate across pauses within the same session.

After a song qualifies, its timestamp updates periodically while you continue listening and is finalized from the last observed listening time when playback stops or changes. The displayed value is a last-listened timestamp, not a play count.

Recording requires this Spotify client to be open with the extension running. Listening on another device while this client is closed is not automatically collected. A later history import can add those plays.

### “Not recorded yet”

This means there is no qualifying timestamp for that exact track ID in the local database. It does **not** mean you have never listened to the song.

Different releases of the same song can have different Spotify track IDs. Their histories are kept separate; the extension does not guess matches from song titles or artists.

## Import older listening history

1. Open [Spotify's privacy settings](https://www.spotify.com/account/privacy/).
2. Find **Download your data** and request **Extended streaming history**.
3. When Spotify makes the export available, download it.
4. In the desktop client, open your **profile menu → Last Played**.
5. Select the ZIP archive, or extract it and select the history JSON files. You can select several files together.

Typical history filenames include `Streaming_History_Audio_*.json` and `endsong_*.json`.

The importer uses these fields:

| Field | Purpose |
|---|---|
| `spotify_track_uri` | Identifies the exact song |
| `ts` | Timestamp when the historical stream ended |
| `ms_played` | Determines whether the stream meets the 30-second threshold |

Only qualifying music-track records are imported. Short plays, podcasts, missing track IDs, and invalid timestamps are skipped. The import summary reports the results.

**Choose Extended streaming history, rather than the smaller Account data export.** The latter may lack the track IDs needed for reliable matching.

Imports merge with your existing records. The newest qualifying timestamp wins, so importing the same history again does not replace newer timestamps with older ones. Historical timestamps use Spotify's recorded stream-ending time; live timestamps use the last observed listening time in this client.

If a ZIP cannot be opened, extract it and import the JSON files instead. Password-protected archives and ZIP64 archives are not supported. For large exports, import the individual history files in smaller groups.

For details about Spotify's export, see [Understanding your data](https://support.spotify.com/us/article/understanding-your-data/).

## Settings and backups

Open **profile menu → Last Played** to:

- Choose **Relative time** or **Calendar date** for the column.
- Import Spotify history or a Last Played backup.
- Export a backup of your recorded timestamps.
- See how many tracks have a recorded timestamp.

Hovering over a known timestamp shows the full date and time in either display mode.

To move your history to another computer, select **Export Last Played backup**, install the extension on the new computer, and import that JSON file through the same settings panel.

## Privacy and storage

Listening records are stored locally in an account-specific IndexedDB database inside Spotify's application storage. The database stores track URIs and timestamps. Imported history is processed locally; unrelated export fields, such as IP addresses and device information, are not retained.

The extension does not upload listening history or automatically sync it between computers. **Export a backup before clearing Spotify's application data, resetting its storage, or moving to another installation.**

## Compatibility

Last Played is a separate extension and does not require Star Ratings. It includes compatibility handling for the customized Star Ratings extension developed alongside it. Other Star Ratings versions, themes, and extensions that change playlist columns may need additional testing.

The column is intended for playlist views that display **Date added**. It is not added to album pages or recommended-song rows.

Spotify's interface and internal APIs can change between releases. This is an early release: syntax checks, listening/import tests, and simulated playlist integration tests have passed, but those checks do not establish compatibility with every Spotify version or theme.

## Troubleshooting

### The column is missing

- Check that `last-played.js` is in your `Extensions` folder and enabled in Spicetify.
- Run `spicetify apply` and restart Spotify.
- Open a playlist view that includes **Date added**.
- Check **profile menu → Last Played**. If the entry is missing, the extension may not have started.
- Check Spotify's developer console for messages beginning with `[Last Played]`.

### Every song says “Not recorded yet”

Listen to a song for at least 30 seconds with the extension running, or import your Extended Streaming History. Also check whether the playlist uses a different release of the song from the one in your history.

### An import finds no qualifying records

Make sure you selected the Extended Streaming History files. Records need a valid `spotify_track_uri`, timestamp, and at least 30,000 milliseconds played. Read the import summary for skipped records or file errors.

### The columns overlap or no longer line up

Try the default Spotify layout and temporarily disable other extensions that modify playlist columns. When reporting the problem, include your Spotify version, Spicetify version, other column-modifying extensions, and a screenshot of the affected playlist.

## Uninstall

Disable the extension with:

```shell
spicetify config extensions last-played.js-
spicetify apply
```

The trailing `-` removes it from Spicetify's extension list. Disabling the extension does not itself delete its stored history.

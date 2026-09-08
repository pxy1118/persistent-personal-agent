param(
  [ValidateSet('primary', 'all')]
  [string]$Display = 'primary',
  [ValidateRange(640, 3840)]
  [int]$MaxWidth = 1920
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$bounds = if ($Display -eq 'all') {
  [System.Windows.Forms.SystemInformation]::VirtualScreen
} else {
  [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw 'No interactive display is available.'
}

$source = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($source)
$output = $null
$stream = $null
try {
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  if ($source.Width -gt $MaxWidth) {
    $height = [Math]::Max(1, [int][Math]::Round($source.Height * $MaxWidth / $source.Width))
    $output = [System.Drawing.Bitmap]::new($MaxWidth, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $scaled = [System.Drawing.Graphics]::FromImage($output)
    try {
      $scaled.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scaled.DrawImage($source, 0, 0, $MaxWidth, $height)
    } finally {
      $scaled.Dispose()
    }
  } else {
    $output = $source.Clone()
  }
  $stream = [System.IO.MemoryStream]::new()
  $output.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
} finally {
  if ($stream) { $stream.Dispose() }
  if ($output) { $output.Dispose() }
  $graphics.Dispose()
  $source.Dispose()
}

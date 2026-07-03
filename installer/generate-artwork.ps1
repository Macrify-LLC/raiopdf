$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$OutputDir = Join-Path $PSScriptRoot "artwork"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function ColorFromHex {
  param([Parameter(Mandatory = $true)][string]$Hex)

  $value = $Hex.TrimStart("#")
  return [System.Drawing.Color]::FromArgb(
    [Convert]::ToInt32($value.Substring(0, 2), 16),
    [Convert]::ToInt32($value.Substring(2, 2), 16),
    [Convert]::ToInt32($value.Substring(4, 2), 16)
  )
}

function New-Font {
  param(
    [Parameter(Mandatory = $true)][float]$Size,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
  )

  return [System.Drawing.Font]::new("Segoe UI", $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Save-Bitmap {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [Parameter(Mandatory = $true)][scriptblock]$Draw
  )

  $path = Join-Path $OutputDir $Name
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  try {
    & $Draw $graphics $Width $Height
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  }
  finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Draw-SunMark {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][float]$CenterX,
    [Parameter(Mandatory = $true)][float]$CenterY,
    [Parameter(Mandatory = $true)][float]$Scale,
    [switch]$OnDark
  )

  $amberBright = ColorFromHex "#F59E0B"
  $amberSoft = ColorFromHex "#F5B942"
  $navy = ColorFromHex "#1B3A5C"
  $ring = if ($OnDark) { ColorFromHex "#F7FAFE" } else { $navy }
  $center = if ($OnDark) { $navy } else { ColorFromHex "#F7FAFE" }

  for ($i = 0; $i -lt 8; $i++) {
    $angle = (($i * 45) - 90) * [Math]::PI / 180
    $inner = 27 * $Scale
    $outer = 48 * $Scale
    $width = [Math]::Max(2.2, 8.2 * $Scale)
    $color = if (($i % 2) -eq 0) { $amberBright } else { $amberSoft }
    $pen = [System.Drawing.Pen]::new($color, $width)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    try {
      $x1 = $CenterX + ([Math]::Cos($angle) * $inner)
      $y1 = $CenterY + ([Math]::Sin($angle) * $inner)
      $x2 = $CenterX + ([Math]::Cos($angle) * $outer)
      $y2 = $CenterY + ([Math]::Sin($angle) * $outer)
      $Graphics.DrawLine($pen, [float]$x1, [float]$y1, [float]$x2, [float]$y2)
    }
    finally {
      $pen.Dispose()
    }
  }

  $centerBrush = [System.Drawing.SolidBrush]::new($center)
  $ringPen = [System.Drawing.Pen]::new($ring, [Math]::Max(2.4, 8 * $Scale))
  try {
    $centerRadius = 13 * $Scale
    $radius = 18 * $Scale
    $Graphics.FillEllipse($centerBrush, $CenterX - $centerRadius, $CenterY - $centerRadius, $centerRadius * 2, $centerRadius * 2)
    $Graphics.DrawEllipse($ringPen, $CenterX - $radius, $CenterY - $radius, $radius * 2, $radius * 2)
  }
  finally {
    $ringPen.Dispose()
    $centerBrush.Dispose()
  }
}

function Draw-AccentBar {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Y
  )

  $rect = [System.Drawing.Rectangle]::new(0, $Y, $Width, 4)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    (ColorFromHex "#132D52"),
    (ColorFromHex "#4AADE0"),
    0
  )
  try {
    $Graphics.FillRectangle($brush, $rect)
  }
  finally {
    $brush.Dispose()
  }
}

function Fill-Background {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [switch]$Dark
  )

  $rect = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
  if ($Dark) {
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $rect,
      (ColorFromHex "#0B1A2E"),
      (ColorFromHex "#1D4E8F"),
      55
    )
  }
  else {
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $rect,
      (ColorFromHex "#F7FAFE"),
      (ColorFromHex "#EDF4FB"),
      0
    )
  }

  try {
    $Graphics.FillRectangle($brush, $rect)
  }
  finally {
    $brush.Dispose()
  }
}

function Draw-Text {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][float]$X,
    [Parameter(Mandatory = $true)][float]$Y,
    [Parameter(Mandatory = $true)][float]$Size,
    [Parameter(Mandatory = $true)][string]$Color,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular,
    [float]$MaxWidth = 0
  )

  $font = New-Font -Size $Size -Style $Style
  $brush = [System.Drawing.SolidBrush]::new((ColorFromHex $Color))
  try {
    if ($MaxWidth -gt 0) {
      $measured = $Graphics.MeasureString($Text, $font)
      if ($measured.Width -gt ($MaxWidth + 1)) {
        throw "Text '$Text' measures $([Math]::Round($measured.Width, 1))px, exceeding the $MaxWidth px fit limit."
      }
    }
    $Graphics.DrawString($Text, $font, $brush, $X, $Y)
  }
  finally {
    $brush.Dispose()
    $font.Dispose()
  }
}

function Draw-DocumentCard {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height
  )

  $surface = [System.Drawing.SolidBrush]::new((ColorFromHex "#F7FAFE"))
  $border = [System.Drawing.Pen]::new((ColorFromHex "#D4DFEE"), 1)
  $line = [System.Drawing.Pen]::new((ColorFromHex "#5A6F8A"), 1)
  $accent = [System.Drawing.SolidBrush]::new((ColorFromHex "#F5B942"))
  try {
    $Graphics.FillRectangle($surface, $X, $Y, $Width, $Height)
    $Graphics.DrawRectangle($border, $X, $Y, $Width, $Height)
    $Graphics.FillRectangle($accent, $X + 12, $Y + 14, 52, 6)
    for ($i = 0; $i -lt 5; $i++) {
      $yy = $Y + 38 + ($i * 18)
      $Graphics.DrawLine($line, $X + 14, $yy, $X + $Width - 16, $yy)
    }
  }
  finally {
    $accent.Dispose()
    $line.Dispose()
    $border.Dispose()
    $surface.Dispose()
  }
}

Save-Bitmap "nsis-header.bmp" 150 57 {
  param($g, $w, $h)
  Fill-Background $g $w $h
  Draw-SunMark $g 24 27 0.46
  Draw-Text $g "RaioPDF" 50 10 19 "#0B1A2E" ([System.Drawing.FontStyle]::Bold) 96
  Draw-Text $g "local PDF suite" 51 34 10 "#5A6F8A" ([System.Drawing.FontStyle]::Regular) 92
  Draw-AccentBar $g $w ($h - 4)
}

Save-Bitmap "nsis-sidebar.bmp" 164 314 {
  param($g, $w, $h)
  Fill-Background $g $w $h -Dark
  Draw-SunMark $g 82 72 0.9 -OnDark
  Draw-Text $g "RaioPDF" 31 128 26 "#F7FAFE" ([System.Drawing.FontStyle]::Bold) 116
  Draw-Text $g "Free and local" 35 165 14 "#7EC8F0" ([System.Drawing.FontStyle]::Bold) 100
  Draw-Text $g "Open source" 40 186 14 "#F5B942" ([System.Drawing.FontStyle]::Bold) 92
  Draw-Text $g "GPL-3.0 license" 38 235 11 "#EDF4FB" ([System.Drawing.FontStyle]::Regular) 92
  Draw-Text $g "Bundled notices" 36 253 11 "#EDF4FB" ([System.Drawing.FontStyle]::Regular) 96
  Draw-Text $g "Local processing" 38 271 11 "#EDF4FB" ([System.Drawing.FontStyle]::Regular) 92
}

Save-Bitmap "wix-banner.bmp" 493 58 {
  param($g, $w, $h)
  Fill-Background $g $w $h
  Draw-SunMark $g 34 29 0.52
  Draw-Text $g "RaioPDF" 72 10 22 "#0B1A2E" ([System.Drawing.FontStyle]::Bold) 128
  Draw-Text $g "Free, local PDF suite for law firms" 74 34 12 "#2D3E56" ([System.Drawing.FontStyle]::Regular) 260
  Draw-AccentBar $g $w ($h - 4)
}

Save-Bitmap "wix-dialog.bmp" 493 312 {
  param($g, $w, $h)
  Fill-Background $g $w $h -Dark
  Draw-DocumentCard $g 294 64 132 170
  Draw-DocumentCard $g 336 88 132 170
  Draw-SunMark $g 116 88 1.05 -OnDark
  Draw-Text $g "RaioPDF" 64 150 42 "#F7FAFE" ([System.Drawing.FontStyle]::Bold) 205
  Draw-Text $g "Free, local PDF suite." 68 200 18 "#7EC8F0" ([System.Drawing.FontStyle]::Bold) 205
  Draw-Text $g "GPL-3.0 and bundled notices" 68 232 13 "#EDF4FB" ([System.Drawing.FontStyle]::Regular) 205
  Draw-Text $g "are shown before installation." 68 251 13 "#EDF4FB" ([System.Drawing.FontStyle]::Regular) 205
  Draw-Text $g "No proprietary EULA." 68 270 13 "#F5B942" ([System.Drawing.FontStyle]::Bold) 205
  Draw-AccentBar $g $w ($h - 6)
}

Write-Host "Installer artwork written to $OutputDir"

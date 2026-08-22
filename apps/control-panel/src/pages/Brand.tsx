import { useNavigate, useParams } from 'react-router-dom'
import { useState } from 'react'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { AgencyClient, ProductProfile, CreatorProfile } from '../lib/types'

export function Brand() {
  const navigate = useNavigate()
  const clients = useApi<{ clients: AgencyClient[] }>(() => api.clients())
  const list = clients.data?.clients ?? []
  const products = useApi<{ products: ProductProfile[] }>(() => api.products())
  const creators = useApi<{ creators: CreatorProfile[] }>(() => api.creatorProfiles())
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [creatorName, setCreatorName] = useState('')
  const [creatorEdit, setCreatorEdit] = useState<string | null>(null)
  const [creatorJson, setCreatorJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editJson, setEditJson] = useState('')

  async function ingest() {
    if (!url.trim()) return
    setBusy(true); setError(null)
    try { await api.ingestProductUrl(url.trim()); setUrl(''); products.reload() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function createManual() {
    if (!name.trim()) return
    setBusy(true); setError(null)
    try { await api.createProduct({ name: name.trim(), description: '', shortDescription: '', productCategory: '', targetCustomer: '', customerPain: '', primaryBenefits: [], features: [], claims: [], forbiddenClaims: [], differentiators: [], callToAction: 'Learn more' }); setName(''); products.reload() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function createCreator() { if (!creatorName.trim()) return; setBusy(true); setError(null); try { await api.createCreator({ displayName: creatorName.trim(), description: '', avatarMode: 'reference_images', compatibleVendors: [], speechStyle: '', tone: '', wardrobe: '', visualStyle: '', language: 'en', prohibitedDepictions: [], consentConfirmed: true, active: true }); setCreatorName(''); creators.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  async function saveCreator(creator: CreatorProfile) { try { await api.updateCreator(creator.id, JSON.parse(creatorJson)); setCreatorEdit(null); creators.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  async function uploadCreatorImage(id: string, file: File) { const reader = new FileReader(); reader.onload = async () => { try { const value = String(reader.result ?? ''); await api.uploadCreatorImage(id, { fileName: file.name, mimeType: file.type, dataBase64: value.slice(value.indexOf(',') + 1) }); creators.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }; reader.readAsDataURL(file) }

  async function upload(productId: string, file: File) {
    const reader = new FileReader()
    reader.onload = async () => {
      const value = String(reader.result ?? '')
      const dataBase64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
      try { await api.uploadProductImage(productId, { fileName: file.name, mimeType: file.type, dataBase64 }); products.reload() }
      catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    }
    reader.readAsDataURL(file)
  }

  function beginEdit(product: ProductProfile) {
    setEditing(product.id); setEditJson(JSON.stringify(product, null, 2))
  }
  async function saveEdit(product: ProductProfile) {
    try { const parsed = JSON.parse(editJson) as ProductProfile; await api.updateProduct(product.id, parsed); setEditing(null); products.reload() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-muted-2)]">
        Brand kit and clients. Assembly will burn logo, color, and captions from this kit.
      </p>
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
        {list.map((c) => (
          <button
            key={c.id}
            onClick={() => navigate(paths.brandClient(c.id))}
            className="w-full text-left px-5 py-4 hover:bg-[var(--color-raised)] transition-colors"
          >
            <p className="text-sm">{c.name}</p>
            <p className="text-[11px] text-[var(--color-muted-3)] mt-0.5">{c.niche}</p>
          </button>
        ))}
        {list.length === 0 && !clients.loading && (
          <p className="px-5 py-6 text-[11px] text-[var(--color-muted-3)]">
            No clients yet. Create one in Studio.
          </p>
        )}
      </div>
      {clients.error && <p className="text-[11px] text-[var(--color-red)]">Load error: {clients.error}</p>}

      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest">Product profiles</h2>
          <p className="text-[11px] text-[var(--color-muted-3)] mt-1">Reusable product intelligence for scripts, visuals, captions, and QA.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste product URL" className="flex-1 min-w-56 bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm" />
          <button onClick={ingest} disabled={busy || !url.trim()} className="px-4 py-2 text-[11px] uppercase tracking-widest disabled:opacity-50" style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}>Import URL</button>
        </div>
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Or create a product manually" className="flex-1 min-w-56 bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm" />
          <button onClick={createManual} disabled={busy || !name.trim()} className="px-4 py-2 text-[11px] uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] disabled:opacity-50">Create</button>
        </div>
        {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
        <div className="divide-y divide-[var(--color-raised)] border border-[var(--color-border)]">
          {(products.data?.products ?? []).map((product) => (
            <div key={product.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48"><p className="text-sm">{product.name}</p><p className="text-[10px] text-[var(--color-muted-3)]">{product.extractionStatus} · {product.productImages.length} images</p></div>
              {product.canonicalUrl && <a href={product.canonicalUrl} target="_blank" rel="noreferrer" className="text-[10px] text-[var(--color-lime)]">SOURCE ↗</a>}
              <label className="text-[10px] uppercase tracking-widest border border-[var(--color-faint)] px-2 py-1 cursor-pointer">+ image<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(product.id, file); e.currentTarget.value = '' }} /></label>
              <button onClick={() => beginEdit(product)} className="text-[10px] uppercase tracking-widest text-[var(--color-lime)]">Edit</button>
              <button onClick={() => { void api.deleteProduct(product.id).then(() => products.reload()).catch((e) => setError(e instanceof Error ? e.message : String(e))) }} className="text-[10px] uppercase tracking-widest text-[var(--color-red)]">Delete</button>
              {product.productImages.map((image) => <span key={image.id} className="relative"><img src={`/accounts/products/${product.id}/images/${image.id}`} alt={image.fileName} className="h-10 w-10 object-cover" /><button onClick={() => { void api.deleteProductImage(product.id, image.id).then(() => products.reload()) }} className="absolute -right-1 -top-1 bg-black text-white text-[9px]">×</button></span>)}
              {editing === product.id && <div className="basis-full border-t border-[var(--color-border)] pt-3"><p className="text-[10px] text-[var(--color-muted-3)] mb-1">Edit every profile field as JSON (arrays are one value per item).</p><textarea value={editJson} onChange={(e) => setEditJson(e.target.value)} className="w-full min-h-64 bg-[var(--color-bg)] border border-[var(--color-input)] p-2 text-xs font-mono" /><button onClick={() => void saveEdit(product)} className="mt-2 px-3 py-2 text-[10px] uppercase tracking-widest bg-[var(--color-lime)]">Save profile</button></div>}
            </div>
          ))}
          {(products.data?.products ?? []).length === 0 && <p className="px-4 py-4 text-[11px] text-[var(--color-muted-3)]">No product profiles yet.</p>}
        </div>
      </section>
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3"><h2 className="text-sm font-semibold uppercase tracking-widest">Creator profiles</h2><p className="text-[11px] text-[var(--color-muted-3)]">Reference-guided creators with explicit vendor compatibility. Soul ID persists face identity across all generations.</p><div className="flex gap-2"><input value={creatorName} onChange={(e) => setCreatorName(e.target.value)} placeholder="Creator display name" className="flex-1 bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm" /><button onClick={() => void createCreator()} disabled={busy || !creatorName.trim()} className="px-4 py-2 text-[11px] uppercase tracking-widest" style={{ backgroundColor: 'var(--color-lime)' }}>Create</button></div><div className="divide-y divide-[var(--color-raised)] border border-[var(--color-border)]">{(creators.data?.creators ?? []).map((creator) => <div key={creator.id} className="px-4 py-3 flex flex-wrap gap-3 items-start"><div className="flex-1"><span className="text-sm block">{creator.displayName}</span><span className="text-[10px] text-[var(--color-muted-3)]">{creator.avatarMode} · {creator.referenceImages.length} photos · {creator.active ? 'active' : 'archived'}</span></div><SoulIdBadge status={(creator as any).faceEmbeddingStatus ?? 'none'} primaryUrl={(creator as any).primaryReferenceImageUrl} /><button onClick={() => void api.trainCreatorIdentity(creator.id).then(() => creators.reload()).catch((e) => setError(e instanceof Error ? e.message : String(e)))} disabled={creator.referenceImages.length < 3 || creator.avatarMode === 'none'} className="px-3 py-1.5 text-[10px] uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed" title={creator.referenceImages.length < 3 ? 'Need at least 3 reference photos' : creator.avatarMode === 'none' ? 'Set avatarMode to reference_images first' : 'Train persistent face identity'}>Train Identity</button><button onClick={() => { setCreatorEdit(creator.id); setCreatorJson(JSON.stringify(creator, null, 2)) }} className="text-[10px] text-[var(--color-lime)]">Edit</button><button onClick={() => void api.archiveCreator(creator.id).then(() => creators.reload())} className="text-[10px] text-[var(--color-red)]">Archive</button>{creatorEdit === creator.id && <div className="basis-full"><textarea value={creatorJson} onChange={(e) => setCreatorJson(e.target.value)} className="w-full min-h-52 bg-[var(--color-bg)] border border-[var(--color-input)] p-2 text-xs font-mono" /><button onClick={() => void saveCreator(creator)} className="mt-2 px-3 py-2 text-[10px] bg-[var(--color-lime)]">Save</button></div>}</div>)}</div></section>
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5"><h3 className="text-[11px] uppercase tracking-widest mb-3">Reference image manager</h3>{(creators.data?.creators ?? []).map((creator) => <div key={creator.id} className="flex flex-wrap gap-2 items-center mb-2"><span className="text-xs w-32">{creator.displayName}</span><label className="text-[10px] text-[var(--color-lime)] cursor-pointer">Upload<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCreatorImage(creator.id, f); e.currentTarget.value = '' }} /></label>{creator.referenceImages.map((image) => <span key={image.id} className="relative"><img src={`/accounts/creators/${creator.id}/images/${image.id}`} alt={image.fileName} className="h-10 w-10 object-cover" /><button onClick={() => void api.deleteCreatorImage(creator.id, image.id).then(() => creators.reload())} className="absolute -right-1 -top-1 bg-black text-white text-[9px]">×</button></span>)}</div>)}</section>
    </div>
  )
}

export function BrandClient() {
  const { id } = useParams()
  const navigate = useNavigate()
  const clients = useApi<{ clients: AgencyClient[] }>(() => api.clients())
  const client = (clients.data?.clients ?? []).find((c) => c.id === id)

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate(paths.brand)}
        className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        Back to brand
      </button>
      {client ? (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-2">
          <p className="text-lg font-semibold">{client.name}</p>
          <p className="text-sm text-[var(--color-muted-2)]">{client.niche}</p>
          <p className="text-[11px] font-mono text-[var(--color-muted-3)]">{client.id}</p>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-muted-2)]">Client not found.</p>
      )}
    </div>
  )
}

/** Soul ID status badge with optional primary face thumbnail. */
function SoulIdBadge({ status, primaryUrl }: { status: string; primaryUrl?: string }) {
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    none: { bg: 'transparent', text: 'var(--color-muted-3)', label: 'No Identity' },
    training: { bg: 'rgba(255,200,0,0.1)', text: '#ffc800', label: 'Training…' },
    ready: { bg: 'rgba(200,255,0,0.08)', text: 'var(--color-lime)', label: '✓ Identity Ready' },
    failed: { bg: 'rgba(255,43,43,0.08)', text: 'var(--color-red)', label: '✗ Failed' },
  }
  const s = styles[status] ?? styles.none
  return (
    <div className="flex items-center gap-2">
      {status === 'ready' && primaryUrl && (
        <img
          src={primaryUrl}
          alt="Primary face"
          className="h-8 w-8 object-cover border border-[var(--color-lime)]"
        />
      )}
      <span
        className="text-[9px] uppercase tracking-widest px-2 py-0.5 border"
        style={{ borderColor: s.text, color: s.text, backgroundColor: s.bg }}
      >
        {s.label}
      </span>
    </div>
  )
}

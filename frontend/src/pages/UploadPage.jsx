import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, CheckCircle } from 'lucide-react';
import { api } from '../api';

export default function UploadPage() {
  const navigate = useNavigate();
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [uploading, setUploading] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => { api.getCameras().then(setCameras).catch(() => {}); }, []);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setSuccess(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file || !cameraId) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      fd.append('cameraId', cameraId);
      fd.append('notes', notes);
      const ev = await api.uploadEvent(fd);
      setSuccess(true);
      setTimeout(() => navigate(`/events/${ev._id}`), 1200);
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page">
      <h1>Upload Image</h1>

      {cameras.length === 0 && (
        <p className="empty-text">Please add a camera first before uploading.</p>
      )}

      <form className="upload-form" onSubmit={handleSubmit}>
        <div className="upload-drop" onClick={() => document.getElementById('fileInput').click()}>
          {preview ? (
            <img src={preview} alt="preview" className="upload-preview" />
          ) : (
            <div className="upload-placeholder">
              <Upload size={48} />
              <p>Click to select an image</p>
            </div>
          )}
          <input id="fileInput" type="file" accept="image/*" onChange={handleFile} hidden />
        </div>

        <div className="form-group">
          <label>Camera *</label>
          <select required value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
            <option value="">Select camera</option>
            {cameras.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Notes</label>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes..." />
        </div>

        <button type="submit" className="btn btn-primary btn-lg" disabled={!file || !cameraId || uploading}>
          {uploading ? 'Uploading...' : success ? <><CheckCircle size={16} /> Uploaded!</> : <><Upload size={16} /> Upload & Analyze</>}
        </button>
      </form>
    </div>
  );
}
